"""Business tools served over stdio to one employee's Hermes runtime."""
import csv
import hashlib
import io
import json
import re
import os
from decimal import Decimal, localcontext
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Literal, TypedDict
from urllib.request import Request, urlopen


def hub(ticket, result=None):
    if not re.fullmatch(r"[0-9a-f]{24}", ticket):
        raise ValueError("work は今回の依頼に記載された識別子を指定してください。")
    body = json.dumps({"ticket": ticket, "result": result}).encode()
    req = Request("http://hub:18800/work-tool", data=body, headers={"Content-Type": "application/json"})
    timeout = 60 if result and result.get("tool") == "search_libraries" else 5
    with urlopen(req, timeout=timeout) as response:
        return json.load(response)


def save(work, name, memo, evidence, conditions=None):
    hub(work, {"tool": name, "memo": memo, "evidence": evidence, "conditions": conditions or []})
    return memo


def quote_skill_path(skill_id):
    from hermes_constants import get_hermes_home
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", skill_id):
        raise ValueError("個人スキルを確認できません。")
    return get_hermes_home() / "skills" / ("hub-quote-" + skill_id) / "SKILL.md"


def save_quote_skill(work: str, criteria: list[str], rules: list[str]) -> str:
    """Save ordered criterion names and reusable rules. Copy each rule verbatim from the employee's revision_instruction, or pass []. Never include supplier names, amounts, dates or refs."""
    from tools.skill_manager_tool import skill_manage
    skill = hub(work, {"tool":"prepare_quote_skill", "criteria":criteria, "rules":rules})
    path = quote_skill_path(skill["id"])
    content = (f"---\nname: {path.parent.name}\ndescription: 採用した比較基準で新しい2社の見積を比較する\n---\n\n"
               "# 自分用の見積比較\n\n以下の比較項目を同じ名前・順序で使用する。\n\n" +
               "\n".join("- " + label for label in skill["criteria"]) +
               ("\n\n判断ルール\n" + "\n".join(skill["rules"]) if skill["rules"] else "") +
               "\n\ncompare_quotes で今回の見積2件の passages から各社の該当 ref を選ぶ。記載なしは空の ref とし、要確認と表示する。\n")
    if not path.exists():
        result = json.loads(skill_manage(action="create", name=path.parent.name, content=content))
        if not result.get("success") and not path.exists():
            raise ValueError(result.get("error", "Hermesが個人スキルを保存できませんでした。"))
    stored = path.read_bytes()
    if stored.decode().strip() != content.strip():
        raise ValueError("保存済みの個人スキルの内容が一致しません。")
    hub(work, {"tool":"confirm_quote_skill", "hash":hashlib.sha256(stored).hexdigest()})
    return "SKILL.md に保存しました。"


def load_workflow(work: str, name: Literal["csv-summary", "source-answer", "document-draft", "quote-comparison"]) -> str:
    """Open a work procedure. Choose quote-comparison to compare supplier quotes, csv-summary for calculations, source-answer for questions, document-draft for writing."""
    if name not in {"csv-summary", "source-answer", "document-draft", "quote-comparison"}:
        raise ValueError("利用できる手順を選んでください。")
    loaded = hub(work) if name in {"quote-comparison", "csv-summary"} else {}
    skill = loaded.get("quote_skill")
    root = Path(__file__).resolve().parent
    workflows = root / "skills" if (root / "skills").is_dir() else root.parent / "skills"
    path = quote_skill_path(skill["id"]) if skill else workflows / name / "SKILL.md"
    content = path.read_bytes()
    text = content.decode()
    title = next(line[2:] for line in text.splitlines() if line.startswith("# "))
    registered = hub(work, {"tool":"load_workflow", "name":name, "title":title,
                            "hash":hashlib.sha256(content).hexdigest(), "procedure_delivery":1})
    release = registered.get("standard_procedure")
    if release:
        text = release["instruction"]
        if hashlib.sha256(text.encode()).hexdigest() != release["content_hash"]:
            raise ValueError("標準手順の版と内容が一致しません。")
    if name == "csv-summary" and loaded.get("csv_skill"):
        from hermes_constants import get_hermes_home
        release = loaded["csv_skill"]
        identifier, version, body = release["id"], release["version"], release["body"]
        if not re.fullmatch(r"[0-9a-f-]{36}", identifier) or not isinstance(version, int) or version < 1:
            raise ValueError("本人の集計手順と版を確認できません。")
        if hashlib.sha256(body.encode()).hexdigest() != release["hash"]:
            raise ValueError("集計手順の内容が一致しません。")
        stored = get_hermes_home() / "skills" / f"hub-csv-{identifier}-v{version}" / "SKILL.md"
        stored.parent.mkdir(parents=True, exist_ok=True)
        if not stored.exists():
            with NamedTemporaryFile(mode="w", encoding="utf-8", dir=stored.parent, delete=False) as file:
                file.write(body)
                temp_name = file.name
            os.replace(temp_name, stored)
        if hashlib.sha256(stored.read_bytes()).hexdigest() != release["hash"]:
            raise ValueError("保存済みの集計手順の版を確認してください。")
        return text + "\n\n" + body
    return text


def sum_csv(text, amount_column, group_column, filter_column, exclude_value, include_value):
    text = text.removeprefix("\ufeff")
    lines = text.splitlines(keepends=True)
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    header = [s.strip() for s in next(reader, [])]
    if not header or len(set(header)) != len(header) or "" in header:
        raise ValueError("見出し行には重複のない列名が必要です。")
    if bool(filter_column) != bool(exclude_value or include_value) or (exclude_value and include_value):
        raise ValueError("絞り込みには列名と、除外または採用する値を1つ指定してください。")
    amount = header.index(amount_column)
    group = header.index(group_column) if group_column else None
    condition = header.index(filter_column) if filter_column else None
    start = reader.line_num
    totals = {}
    evidence = []
    with localcontext() as ctx:
        ctx.prec = 100
        for cells in reader:
            end = reader.line_num
            first, raw = start + 1, "".join(lines[start:end]).rstrip("\r\n")
            start = end
            if not cells:
                continue
            if len(cells) != len(header):
                raise ValueError(f"{first}行目の列数が見出しと一致しません。")
            active = condition is None or (cells[condition].strip() != exclude_value if exclude_value else cells[condition].strip() == include_value)
            if active:
                value = cells[amount].strip()
                if not re.fullmatch(r"[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", value) or len(value) > 40:
                    raise ValueError(f"{first}行目の金額を数値として読めません。")
                key = (cells[group].strip() or "（空欄）") if group is not None else "全件"
                totals[key] = totals.get(key, Decimal(0)) + Decimal(value.replace(",", ""))
            evidence.append({"label": ("採用" if active else "除外") + f" ・ {first}行目", "text": raw})
        total = sum(totals.values(), Decimal(0))
    conditions = ["金額列　" + amount_column, "グループ　" + (group_column or "全件")]
    conditions.append((filter_column + " が「" + (exclude_value or include_value) + "」の行を" + ("除外" if exclude_value else "採用")) if filter_column else "すべての明細行を採用")
    return conditions, totals, total, evidence


def aggregate_csv(work: str, source: int = 1, amount_column: str = "", group_column: str = "", filter_column: str = "", exclude_value: str = "", include_value: str = "") -> str:
    """Sum original CSV rows exactly. Use original column names. Set filter_column and an exact exclude_value or include_value only when requested."""
    data = hub(work)
    recipe = data.get("csv_recipe") or dict(amount_column=amount_column, group_column=group_column,
            filter_column=filter_column, exclude_value=exclude_value, include_value=include_value)
    if data.get("csv_recipe"):
        source = 1
    item = next(s for s in data["sources"] if s["id"] == source)
    conditions, totals, total, rows = sum_csv(item["text"], **recipe)
    columns = [recipe["group_column"] or "対象", recipe["amount_column"]+"（合計）"]
    memo = "集計条件\n" + "、".join(conditions) + f" [{source}]\n\n" + "　".join(columns) + "\n" + "\n".join(f"{k}　{v:,f} [{source}]" for k, v in totals.items()) + f"\n合計　{total:,f} [{source}]"
    rows.insert(0, {"label": "見出し", "text": item["text"].splitlines()[0]})
    hub(work, dict(tool="aggregate_csv", memo=memo, evidence=[dict(r, source=source) for r in rows],
                   conditions=conditions, recipe=recipe))
    return memo


def selected(data, refs):
    lookup = {p["ref"]: p for p in data["passages"]}
    if any(ref not in lookup for ref in refs):
        raise ValueError("資料の passages にある ref を指定してください。")
    return [lookup[ref] for ref in dict.fromkeys(refs)]


class QuoteRow(TypedDict):
    label: str
    left_ref: str
    right_ref: str


def compare_quotes(work: str, rows: list[QuoteRow]) -> str:
    """Build a purchasing comparison of source 1 and 2. For each requested criterion supply its label and the exact passage ref from each source. Use an empty string for an unstated term."""
    data = hub(work)
    documents = data["sources"][:2]
    if len(documents) != 2 or not 1 <= len(rows) <= 30:
        raise ValueError("比較には見積2件と比較項目が必要です。")
    lookup = {p["ref"]:p for p in data["passages"]}
    table = {"columns":[s["title"] for s in documents], "rows":[]}
    memo = ["見積比較表", " / ".join(f'{s["title"]} [{s["id"]}]' for s in documents)]
    labels = set()
    for row in rows:
        label = row["label"].strip()
        if not label or len(label)>100 or label in labels:
            raise ValueError("比較項目名を確認してください。")
        labels.add(label)
        cells = []
        for doc, key in zip(documents, ("left_ref", "right_ref")):
            ref = row[key].strip()
            if ref and (ref not in lookup or lookup[ref]["source"] != doc["id"]):
                raise ValueError(f'{label}の資料番号とrefを確認してください。')
            cells.append({"ref":ref,"text":lookup[ref]["text"] if ref else "要確認（記載なし）",
                          "source":doc["id"], "offset":lookup[ref]["offset"] if ref else None})
        table["rows"].append({"label":label,"cells":cells})
        memo.append(label + "\n" + "\n".join(f'{c["text"]} [{c["source"]}]' for c in cells))
    text = "\n\n".join(memo)
    hub(work, {"tool":"compare_quotes","memo":text,"evidence":[],"conditions":[],"table":table})
    return text


def read_passages(work: str, refs: list[str]) -> str:
    """Look up evidence for a question. Select exact passage ref IDs from the input; if no relevant clause exists use an empty list."""
    data = hub(work)
    items = selected(data, refs)
    memo = "\n".join(f'{p["text"]} [{p["source"]}]' for p in items) or "資料に該当する記載はありません。"
    return save(work, "read_passages", memo, items)


def search_libraries(work: str, query: str) -> str:
    """Search the employee-selected internal libraries for passages. Use Japanese content keywords relevant to the question. Use read_passages next, including an empty refs list when nothing answers the question."""
    result=hub(work,{"tool":"search_libraries","query":query})
    return json.dumps(result,ensure_ascii=False)


def draft_document(work: str, refs: list[str], audience_ref: str = "", start_ref: str = "", action_ref: str = "") -> str:
    """Prepare evidence for a draft or announcement. refs are source passage IDs. For a change notice identify audience, effective date and required action by exact passage IDs; leave missing fields empty."""
    data = hub(work)
    items = selected(data, refs)
    sections = []
    for label, ref in [("対象者", audience_ref), ("開始日", start_ref), ("必要な行動", action_ref)]:
        if ref:
            p = selected(data, [ref])[0]
            sections.append(dict(p, label=label))
        else:
            sections.append({"label": label, "text": "記載なし"})
    # Use the source wording for operational details, including dates without a year.
    used = {p.get("ref") for p in sections}
    additional = [p for p in items if p["ref"] not in used]
    facts = [p["label"] + "　" + p["text"] + (f' [{p["source"]}]' if "source" in p else "") for p in sections]
    memo = "制度変更のお知らせ\n\n" + "\n\n".join(facts)
    for p in additional:
        memo += f'\n\n{p["text"]} [{p["source"]}]'
    return save(work, "draft_document", memo, sections + additional)


if __name__ == "__main__":
    from mcp.server.mcpserver import MCPServer

    server = MCPServer("work")
    for tool in (load_workflow, aggregate_csv, read_passages, draft_document, compare_quotes, search_libraries, save_quote_skill):
        server.tool()(tool)
    server.run()

