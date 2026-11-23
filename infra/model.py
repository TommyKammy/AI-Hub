"""Offline OpenAI protocol fixture for the Hermes integration lab."""
import json
import os
import re
import csv
import time

MODEL_ID = os.environ.get("FIXTURE_MODEL_ID", "fixture-model")
SPLIT_FIXTURE = os.environ.get("FIXTURE_WP06") == "1"
FAILED_SPLIT_REQUESTS = set()
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


QUOTE_TERMS = {"金額":"金額|総額|合計|価格|円","納期":"納期|納入|営業日","支払条件":"支払|締め|払い",
               "保守費":"保守費|保守料","保証":"保証","有効期限":"有効期限"}


def fixture_choice(context, saved_labels=None, procedure=""):
    """Select from the same published MCP functions as the real model."""
    ask, passages = context["ask"], context["passages"]
    args = {"work": context["work"]}
    if context.get("csv_skill"):
        return "aggregate_csv", args
    if len(context["sources"]) >= 2 and re.search("見積|相見積", ask) and re.search("比較|比べ|一覧",ask):
        criteria = list(QUOTE_TERMS.items())
        requested = [(label, pattern) for label, pattern in criteria if re.search(pattern, ask)]
        if saved_labels:
            requested = [(label,QUOTE_TERMS.get(label,re.escape(label))) for label in saved_labels]
        args["rows"] = []
        for label, pattern in requested or criteria[:3]:
            candidates = [p for p in passages if re.search(pattern,p["text"])]
            if label == "金額":
                candidates.sort(key=lambda p:not re.search(r"金額|総額|合計|価格",p["text"]))
            if "保守" in label and re.search(r"保守費は月額.{0,10}優先",procedure):
                candidates.sort(key=lambda p:"月額" not in p["text"])
            refs = [next((p["ref"] for p in candidates if p["source"]==i), "") for i in (1,2)]
            args["rows"].append({"label":label,"left_ref":refs[0],"right_ref":refs[1]})
        return "compare_quotes", args
    for source in context["sources"]:
        if ("集計" in ask or "合計" in ask) and "," in source["text"]:
            rows = list(csv.reader(source["text"].splitlines()))
            fields = rows[0]
            amount = next((k for k in fields if "金額" in k or k == "売上"), None)
            if not amount:
                continue
            group = next((k for k in fields if k + "別" in ask), "")
            args.update(source=source["id"], amount_column=amount, group_column=group)
            if "返品" in ask and "除" in ask:
                field = next((fields[i] for row in rows[1:] for i,v in enumerate(row) if v == "返品"), "")
                if field:
                    args.update(filter_column=field, exclude_value="返品")
            return "aggregate_csv", args
    if re.search("案内|お知らせ|下書き|作成|告知", ask):
        args["refs"] = [p["ref"] for p in passages]
        for key, pattern in [("audience_ref","対象者|対象は"),("start_ref","開始|施行"),("action_ref","してください|提出すること")]:
            args[key] = next((p["ref"] for p in passages if re.search(pattern,p["text"])), "")
        return "draft_document", args
    terms = {ask[i:i+2] for i in range(len(ask)-1)}
    ranked = sorted(passages,key=lambda p:sum(t in p["text"] for t in terms),reverse=True)
    args["refs"] = [p["ref"] for p in ranked[:1]]
    return "read_passages", args


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, content, mime="application/json"):
        payload = content.encode() if isinstance(content, str) else json.dumps(content).encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.endswith("/models"):
            self.respond(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]})
        else:
            self.respond(404, {})

    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.respond(404, {})
            return
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if request.get("model") != MODEL_ID:
            self.respond(404, {"error": {"message": "Unknown model"}})
            return
        user = next((m["content"] for m in reversed(request["messages"]) if m["role"] == "user"), "")
        call = None
        try:
            context = json.loads(user[user.index("AI_HUB_INPUT\n") + len("AI_HUB_INPUT\n"):].split("\nEND_AI_HUB_INPUT")[0])
            sources = context["sources"]
            kind = context.get("kind", "renewal")
            if context["phase"] == "learn_quote":
                if request.get("tools"):
                    labels = [s for s in context["adopted_memo"].splitlines() if s in QUOTE_TERMS]
                    rules = [s.strip() for s in re.findall(r"[^。]+。?",context["revision_instruction"])
                             if re.search("優先|要確認",s)]
                    args = {"work":context["work"], "criteria":labels,"rules":rules}
                    call = {"id":"fixture-quote-skill","type":"function","function":{"name":"mcp__work__save_quote_skill","arguments":json.dumps(args,ensure_ascii=False)}}
                output = "見積の個人スキルを保存しました。"
                revised_memo = True
            elif context["phase"] == "inquiry":
                memo=context["previous_memo"]
                cited=set(re.findall(r"\[(\d+)\]",memo))
                output=json.dumps({"subject":context["ask"][:130]+"についての確認","body":memo[:3600]+"\n\n上記の内容で進めてよいかご確認ください。",
                                   "attachments":[s["id"] for s in sources if str(s["id"]) in cited]},ensure_ascii=False)
                revised_memo=True
            elif context.get("may_save_preference") and re.search(r"結論.{0,5}先", context["ask"]):
                if any(t["function"]["name"] == "memory" for t in request.get("tools", [])):
                    args = {"target":"user","operations":[{"action":"add","content":context["ask"]}]}
                    call = {"id":"fixture-profile","type":"function","function":{"name":"memory","arguments":json.dumps(args,ensure_ascii=False)}}
                output = "プロフィールの更新を確認しました。"
                revised_memo = True
            elif context.get("work"):
                tool_reply = next((m["content"] for m in reversed(request["messages"]) if m["role"] == "tool"), None)
                if isinstance(tool_reply, str) and tool_reply.startswith("<untrusted_tool_result "):
                    _, _, body = tool_reply.partition("\n\n")
                    tool_reply = body.removesuffix("\n</untrusted_tool_result>")
                prior_functions = [c["function"]["name"] for m in request["messages"] for c in (m.get("tool_calls") or [])]
                library = bool(context.get("libraries"))
                needs_tool = (bool(request.get("tools")) and "mcp__work__read_passages" not in prior_functions if library else
                              not any(n != "mcp__work__load_workflow" for n in prior_functions))
                if needs_tool:
                    if library:
                        args={"work":context["work"]}
                        if not prior_functions:
                            name="load_workflow"
                            args["name"]="source-answer"
                        elif "mcp__work__search_libraries" not in prior_functions:
                            name="search_libraries"
                            args["query"]=context["ask"]
                        else:
                            name="read_passages"
                            payload=json.loads(tool_reply)
                            if isinstance(payload,dict) and "result" in payload:
                                payload=json.loads(payload["result"])
                            args["refs"]=[p["ref"] for p in payload["matches"][:2]]
                    else:
                        procedure = tool_reply or ""
                        try:
                            wrapped = json.loads(procedure)
                            if isinstance(wrapped, dict):
                                procedure = wrapped.get("result", procedure)
                        except ValueError:
                            pass
                        labels = re.findall(r"^- (.+)$", procedure, re.M) if "# 自分用の見積比較" in procedure else None
                        name, args = fixture_choice(context, labels, procedure)
                    if tool_reply is None and not library:
                        workflow = {"aggregate_csv":"csv-summary","read_passages":"source-answer","draft_document":"document-draft","compare_quotes":"quote-comparison"}[name]
                        name, args = "load_workflow", {"work":context["work"], "name":workflow}
                    call = {"id":"fixture-"+name,"type":"function","function":{"name":"mcp__work__"+name,"arguments":json.dumps(args,ensure_ascii=False)}}
                    output = ""
                else:
                    output = str(tool_reply)
                    # The MCP SDK can wrap a text result in JSON.
                    try:
                        value = json.loads(output)
                        if isinstance(value,dict):
                            output = value.get("result", output)
                        if isinstance(value,list):
                            output = "\n".join(block["text"] for block in value if block.get("type")=="text")
                    except (TypeError, ValueError):
                        pass
                    if not library and not re.search(r"\[\d+\]", output):
                        output += " [1]"
                    prompt = "\n".join(m["content"] for m in request["messages"] if m["role"] == "system")
                    profile = re.search(r"USER PROFILE \(who the user is\)[^\n]*\n═+\n(.+?)(?:\n\n|\Z)", prompt, re.S)
                    if profile and re.search(r"結論.{0,5}先", profile[1]) and prior_functions[-1:] == ["mcp__work__read_passages"]:
                        output = "結論　" + output
                revised_memo = True
            elif context["phase"] == "compose" and sources[0].get("edition") == "old":
                from difflib import SequenceMatcher
                previous, current = ([line.strip() for line in re.split(r"\n|(?<=。)", s["text"]) if line.strip()] for s in sources)
                changes = []
                for tag, i, j, k, end in SequenceMatcher(None, previous, current, autojunk=False).get_opcodes():
                    if tag != "equal":
                        changes.append("旧版　" + (" ".join(previous[i:j]) or "該当記載なし") + " [1]\n新版　" + (" ".join(current[k:end]) or "該当記載なし") + " [2]")
                output = "\n\n".join(changes) or "変更箇所はありません。 [1] [2]"
                revised_memo = True
            elif context["phase"] == "compose" and sources[0].get("period"):
                # The fixture pairs explicitly named subjects. Unmatched entries keep their own period.
                def records(text):
                    rows = {}
                    for line in re.split(r"\n|(?<=。)", text):
                        line = line.strip("・ \t")
                        if not line or line in ("完了", "課題", "来週の予定", "下書き", "記載なし"):
                            continue
                        subject = re.split(r"[：:]|(?:について|は|が)", line, maxsplit=1)[0]
                        rows.setdefault(subject, []).append(line)
                    return rows
                old, new = (records(s["text"]) for s in sources)
                changes = {}
                for subject in dict.fromkeys([*new, *old]):
                    before = " ".join(old.get(subject, [])) or "記載なし"
                    after = " ".join(new.get(subject, [])) or "記載なし"
                    if before != after and re.search("提出済|完了済|解消|完了した", after):
                        group = "完了に変わったこと"
                    elif re.search("確認待ち|未回答|回答待ち", after):
                        group = "引き続き確認待ち" if re.search("確認待ち|未回答|回答待ち",before) else "今回の確認待ち"
                    elif before != after:
                        group = "変更点"
                    else:
                        continue
                    changes.setdefault(group, []).append(f"前回 [1]：{before}\n今回 [2]：{after}")
                output = "\n\n".join(k + "\n" + "\n".join(v) for k,v in changes.items()) or "変更は確認できません。 [1] [2]"
                revised_memo = True
            elif kind != "renewal":
                revised_memo = True
                headings = {"meeting": ["決定事項", "宿題"], "weekly": ["完了", "課題", "来週の予定"]}.get(kind, ["下書き"])
                grouped = {h: [] for h in headings}
                for source in sources:
                    for line in filter(None, re.split(r"\n|(?<=。)", source["text"])):
                        heading = headings[0]
                        if kind == "meeting" and re.search("宿題|担当|提出|までに", line) and not re.search("と決定|に決定", line):
                            heading = headings[1]
                        elif kind == "weekly" and re.search("課題|遅延|懸念|未解決", line):
                            heading = headings[1]
                        elif kind == "weekly" and re.search("来週|予定", line):
                            heading = headings[2]
                        grouped[heading].append(f"・{line.strip()} [{source['id']}]")
                output = "\n\n".join(h + "\n" + "\n".join(lines or ["記載なし"]) for h, lines in grouped.items())
            else:
                first, second = context["sources"]
                output = f"変更点\n{first['text']} [1]\n\n先方への確認事項\n{second['text']} [2]\n\n担当者の判断\n{context['answer']}"
                if context["phase"] == "review":
                    output = f"{first['text']} 一方、{second['text']} 更新予定日をどう扱いますか？"
                revised_memo = context.get("skill_version", 1) >= 2 and context["phase"] == "draft"
                if revised_memo:
                    sources = context["sources"]
                    if context.get("layout") == "meeting":
                        sources = [second, first]
                    facts = [
                        f"{sentence.strip()} [{source['id']}]"
                        for source in sources
                        for sentence in re.split(r"(?<=。)", source["text"])
                        if sentence.strip()
                    ]
                    output = "資料の事実\n" + "\n".join(facts) + "\n\n社員の判断\n" + context["answer"]
            if context["phase"] == "actions":
                items = []
                for index, line in enumerate(context["memo_lines"], 1):
                    if not re.search(r"提出|までに|宿題は|対応する|手配する", line):
                        continue
                    for source in sources:
                        quote = next((s.strip() for s in re.split(r"(?<=。)|\n", source["text"]) if s.strip() and s.strip() in line), "")
                        if not quote:
                            continue
                        person = re.search(r"(?:宿題は|担当は|^)([一-龯]{1,6})(?:が|は)", quote)
                        due = re.search(r"((?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2})(?:まで|を期限)", quote)
                        items.append(dict(line=index, source=source["id"], quote=quote, assignee=person[1] if person else "", due=due[1] if due else ""))
                        break
                output = json.dumps(items, ensure_ascii=False)
                revised_memo = True
            if context["phase"] == "question":
                dates = re.findall(r"\d{1,2}月\d{1,2}日", context["question"])
                matches = [s for s in sources if any(d in s["text"] for d in dates)]
                evidence = matches or sources
                output = "\n".join(f"{s['title']}には「{s['text']}」と記載されています。 [{s['id']}]" for s in evidence)
                revised_memo = True
            request_text = context.get("revision_instruction") or context.get("output_format", "")
            compact = re.search(r"3行|３行|三行|要約|短く|簡潔|上司向け|先に", request_text)
            reuse_renewal_format = kind == "renewal" and context["phase"] == "draft" and (compact or "箇条書き" in request_text)
            if context.get("answer_source"):
                source = next(s for s in sources if s["id"] == context["answer_source"])
                output = context["previous_memo"] + "\n\n窓口の回答\n" + source["text"] + f" [{source['id']}]"
                revised_memo = True
            elif context.get("partial"):
                original = context["previous_memo"]
                body, *citations = re.split(r"(?=\s*\[\d+\])", original, maxsplit=1)
                body = body.strip().lstrip("・").rstrip("。")
                if "箇条書き" in request_text:
                    output = "・" + body + "。" + "".join(citations)
                else:
                    output = body.removesuffix("する") + ("いたします。" if body.endswith("する") else "。") + "".join(citations)
                revised_memo = True
            elif (context["phase"] == "revise" and "見積比較表" in context["previous_memo"] and
                  any(label in request_text for label in QUOTE_TERMS)):
                labels = sorted((label for label in QUOTE_TERMS if label in request_text),key=request_text.index)
                if "追加" in request_text:
                    labels = list(dict.fromkeys([s for s in context["previous_memo"].splitlines() if s in QUOTE_TERMS]+labels))
                rows = []
                for label in labels:
                    row = [label]
                    for source in sources:
                        value = next((v for v in source["text"].splitlines() if re.search(QUOTE_TERMS[label],v)), "要確認（記載なし）")
                        row.append(f'{value} [{source["id"]}]')
                    rows.append("\n".join(row))
                output = "見積比較表\n\n"+"\n\n".join(rows)
                revised_memo = True
            elif context["phase"] == "revise" or reuse_renewal_format:
                # Offline fixture for common formatting requests. The MLX adapter uses the full prompt.
                summary = []
                for source in sources:
                    sentence = re.split(r"[。\n]", source["text"].strip(), maxsplit=1)[0]
                    summary.append(f"{sentence}。 [{source['id']}]")
                if "先方" in request_text and "先に" in request_text:
                    summary.reverse()
                if context.get("answer"):
                    summary.append("対応方針：" + context["answer"])
                if "箇条書き" in request_text:
                    summary = ["・" + line for line in summary]
                elif not compact:
                    self.respond(422, {"error": {"message": "Unsupported offline fixture revision"}})
                    return
                output = "\n".join(summary)
                revised_memo = True
        except (AttributeError, KeyError, IndexError, TypeError, ValueError):
            self.respond(422, {"error": {"message": "Unexpected synthetic input"}})
            return
        if SPLIT_FIXTURE and context["phase"] == "compose":
            if "WP06順序試験" in context["ask"]:
                time.sleep(2)
            if "WP06失敗試験" in context["ask"] and context["ask"] not in FAILED_SPLIT_REQUESTS:
                FAILED_SPLIT_REQUESTS.add(context["ask"])
                output = "対応する出典が存在しません。 [999]"
            for tag, style in [
                ("WP06短文案", "短文案　申請期限を確認してください。"),
                ("WP06丁寧案", "丁寧案　お手数ですが、申請期限をご確認いただけますでしょうか。"),
                ("WP06未確認事項", "点検　例外の対象者と承認者は要確認です。"),
            ]:
                if tag in context["ask"]:
                    output = style + "\n" + output
                    break
        print(json.dumps({"served_model": MODEL_ID, "call_id": self.headers.get("X-Hub-Call"), "job": self.headers.get("X-Hub-Job"),
                          "phase": self.headers.get("X-Hub-Phase"), "version": self.headers.get("X-Hub-Version")}), flush=True)
        if not revised_memo:
            output = ("【モデルB】" if MODEL_ID == "fixture-model-b" else "【モデルA】") + output
        base = {"id": "fixture-response", "created": 1, "model": MODEL_ID}
        message = {"role":"assistant","content":output}
        finish_reason = "stop"
        if call:
            message = {"role":"assistant","tool_calls":[call]}
            finish_reason = "tool_calls"
        if request.get("stream"):
            chunks = []
            if call:
                call["index"] = 0
            for delta, finish in [(message, None), ({}, finish_reason)]:
                chunk = dict(base, object="chat.completion.chunk", choices=[{"index": 0, "delta": delta, "finish_reason": finish}])
                chunks.append("data: " + json.dumps(chunk) + "\n\n")
            if request.get("stream_options", {}).get("include_usage"):
                usage = dict(base, object="chat.completion.chunk", choices=[],
                             usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
                chunks.append("data: " + json.dumps(usage) + "\n\n")
            self.respond(200, "".join(chunks) + "data: [DONE]\n\n", "text/event-stream")
        else:
            self.respond(200, dict(base, object="chat.completion", choices=[
                {"index": 0, "message": message, "finish_reason": finish_reason}],
                usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}))


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Model).serve_forever()
