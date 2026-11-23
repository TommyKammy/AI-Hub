"""Run from the isolated lab directory while both local Wrangler processes are ready."""
import concurrent.futures
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

keys = dict(line.split("=", 1) for line in Path(".dev.vars").read_text().splitlines())
base = "http://127.0.0.1:19475"
worker = "http://127.0.0.1:19474"
ask = "2社の見積を比較して、納期を優先して判断できるよう、各社の納期を出典付きで示してください。"
wrangler = os.environ["WRANGLER"]
def cmd(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()
def docker(*args):
    return cmd("docker","--context","colima-mac-studio-solo",*args)
def write(sql):
    cmd(wrangler,"d1","execute","arrival-db","--local","--command",sql,cwd="arrival")
def dbrows(query, *args, directory="arrival"):
    folder = Path(directory)/".wrangler/state/v3/d1/miniflare-D1DatabaseObject"
    path, = [p for p in folder.glob("*.sqlite") if len(p.stem)==64]
    with sqlite3.connect(f"file:{path}?mode=rw",uri=True) as con:
        con.execute("PRAGMA query_only=ON")
        return con.execute(query,args).fetchall()
def fetch(path, data=None, actor="sato", origin=base):
    request = Request(origin+path,headers={"Authorization":"Bearer "+keys[actor.upper()+"_KEY"],"Content-Type":"application/json"},
                      data=None if data is None else json.dumps(data).encode())
    with urlopen(request,timeout=60) as res:
        return json.load(res)
def open_wait(a,b,seconds):
    return fetch("/consultations",dict(attached=a,expected=b,ask=ask,deadline=int((time.time()+seconds)*1000)))["id"]
def get(id):
    return fetch("/consultations/"+id)
def arrive(id,d,n):
    def send(_):
        return fetch("/consultations/"+id+"/arrival",dict(document=d))["submitted"]
    with concurrent.futures.ThreadPoolExecutor(n) as pool:
        return list(pool.map(send,range(n)))
def count(id):
    return dbrows("SELECT count(*) FROM source_reads WHERE consultation=?",id)[0][0]
def containers():
    lines = docker("ps","--filter","name=workerd-cf-hermes-22-local-lab-Employee","--no-trunc","--format","{{.ID}} {{.Names}}").splitlines()
    return [line.split()[0] for line in lines if not line.endswith("-proxy")]
def save(name,record):
    Path("results",name+".json").write_text(json.dumps(record,ensure_ascii=False,indent=2)+"\n")

write("""INSERT INTO documents VALUES ('a','A社見積.txt','納期は発注後10営業日。'),
 ('rev','権限変更見積.txt','失効確認の合成原文。納期は31営業日。');
 INSERT INTO grants VALUES ('sato','a'),('sato','rev');""")
normal=open_wait("a","b",1800)
denied=open_wait("rev","b",1800)
denied_b=open_wait("a","rev-b",1800)
missing=open_wait("a","absent",5)
assert get(normal)["state"]=="waiting"
assert arrive(normal,"unrelated",2)==[False]*2
assert arrive(normal,"b",2)==[False]*2  # event without the expected document
try:
    fetch("/consultations/"+normal,actor="tanaka")
    raise AssertionError("Another employee could see the consultation")
except HTTPError as err:
    assert err.code==404
fetch("/health",origin=worker)
start=time.time()
old,=containers()
assert docker("exec",old,"printenv","LAB_ACTOR")=="sato"
save("waiting",dict(id=normal,attached="A社見積.txt",waitingFor="B社見積.txt",state=get(normal)["state"],container=old,lastHealth=start))
write("DELETE FROM grants WHERE actor='sato' AND document='rev'")
time.sleep(max(0.1,6-(time.time()-start)))
def tick(_):
    assert fetch("/cdn-cgi/local/scheduled?format=json")["outcome"]=="ok"
with concurrent.futures.ThreadPoolExecutor(4) as pool:
    list(pool.map(tick,range(4)))
notices=fetch("/inbox")
assert [n["consultation"] for n in notices]==[missing] and fetch("/inbox",actor="tanaka")==[]
assert get(missing)["state"]=="expired" and count(missing)==0
save("deadline",dict(id=missing,ticks=4,employeeInbox=notices,otherEmployeeInbox=[],sourceReads=0))
print("Waiting for actual idle stop",normal,flush=True)
while old in containers():
    assert time.time()-start<680,"Container did not stop"
    time.sleep(1)
end=time.time()
assert 590<end-start<670, end-start
assert get(normal)["state"]=="waiting" and count(normal)==0
assert dbrows("SELECT COUNT(*) FROM archive",directory=".")==[(0,)]
save("sleep",dict(container=old,lastHealth=start,firstObservedStopped=end,elapsedSeconds=end-start))
write("""INSERT INTO documents VALUES ('b','B社見積.txt','納期は発注後7営業日。'),('absent','期限後の見積.txt','納期は20営業日。');
 INSERT INTO grants VALUES ('sato','b'),('sato','absent');""")
write("""INSERT INTO documents VALUES ('rev-b','到着した見積.txt','閲覧できない納期は29営業日。');
 INSERT INTO grants VALUES ('sato','rev-b');""")
write("DELETE FROM grants WHERE actor='sato' AND document='rev-b'")
assert arrive(denied_b,"rev-b",4)==[False]*4
assert get(denied_b)["state"]=="denied" and not get(denied_b)["job"] and count(denied_b)==0
assert arrive(missing,"absent",2)==[False]*2 and count(missing)==0
assert arrive(denied,"b",4)==[False]*4 and count(denied)==0
assert get(denied)["job"] is None and get(denied)["state"]=="denied"
assert not containers() and dbrows("SELECT COUNT(*) FROM archive",directory=".")==[(0,)]
save("revoked",dict(id=denied,duplicates=4,revokedIncoming=dict(id=denied_b,state=get(denied_b)["state"],sourceReads=count(denied_b)),grants=dbrows("SELECT actor,document FROM grants WHERE document='rev'"),sourceReads=count(denied),state=get(denied)["state"],containers=containers(),hermesRuns=0))
deliveries=arrive(normal,"b",8)
assert sum(deliveries)==1,deliveries
for _ in range(180):
    consultation=get(normal)
    if consultation.get("result",{}).get("status")=="done": break
    time.sleep(1)
else: raise AssertionError(str(consultation)[:2000])
assert consultation["id"]==normal and consultation["ask"]==ask
job=consultation["result"]
assert job["id"]==consultation["job"] and job["ask"]==ask
table=job["work_tool"]["table"]
assert table["columns"]==["A社見積.txt","B社見積.txt"]
row,=table["rows"]
assert row["label"]=="納期"
for i,days in enumerate([10,7]):
    cell=row["cells"][i]
    assert cell["source"]==i+1 and cell["ref"] and str(days)+"営業日" in cell["text"]
    assert cell["text"] in job["sources"][i]["text"]
assert arrive(normal,"b",2)==[False]*2
new,=containers()
assert old!=new and docker("exec",new,"printenv","LAB_ACTOR")=="sato"
phase=job["id"]+"-compose"
receipt=dbrows("SELECT actor,job_phase,run FROM archive",directory=".")
assert len(receipt)==1 and receipt[0][:2]==("sato",phase)
run=receipt[0][2]
wire=list(map(json.loads,docker("exec","cf-hermes-22-lab-hub-1","cat","/data/test-wire.ndjson").splitlines()))
assert sum(r["type"]=="outbound-post" and r["key"]==phase for r in wire)==1
def hermes(file,sql,key):
    code="import sqlite3,json,sys; print(json.dumps(sqlite3.connect('file:/opt/data/'+sys.argv[1]+'?mode=ro',uri=True).execute(sys.argv[2],(sys.argv[3],)).fetchall()))"
    return json.loads(docker("exec",new,"python","-c",code,file,sql,key))
admission=hermes("state.db","SELECT request_id FROM session_admissions WHERE target_session_id=?","hub-"+phase)
ledger=hermes("runs_idempotency.db","SELECT run_id FROM run_idempotency WHERE idempotency_key=?",phase)
assert admission==ledger==[[run]] and run
assert count(normal)==2 and count(denied)==count(missing)==0
tick(0)
assert fetch("/inbox")==notices
save("result",dict(consultation=normal,job=job["id"],oldContainer=old,newContainer=new,actor="sato",wire=wire,
                   concurrentAccepted=deliveries,lateDuplicates=2,receipt=receipt,hermesAdmission=admission,
                   hermesLedger=ledger,table=table,sourceReads=count(normal),deadlineNotices=len(notices)))
print("Passed",normal,run,flush=True)
