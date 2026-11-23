from pathlib import Path
import sys
import unittest
from decimal import Decimal
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra"))
import work_tools


class WorkToolsTest(unittest.TestCase):
    def test_saved_recipe_controls_source_columns_and_output(self):
        recipe = dict(amount_column="金額", group_column="品名", filter_column="区分", exclude_value="返品", include_value="")
        data = {"csv_recipe":recipe,"sources":[{"id":1,"text":"品名,区分,原価,金額\n紙,売上,40,100\n紙,返品,70,300"}]}
        with patch.object(work_tools,"hub",return_value=data) as hub:
            memo = work_tools.aggregate_csv("work",2,"原価","","","","")
            self.assertIn("品名　金額（合計）",memo)
            self.assertIn("合計　100 [1]",memo)
            result = hub.call_args.args[1]
            self.assertEqual(result["recipe"],recipe)
            self.assertEqual(result["evidence"][-1]["label"],"除外 ・ 3行目")

    def test_quote_comparison_rejects_crossed_and_unknown_sources(self):
        data={"sources":[{"id":1,"title":"甲"},{"id":2,"title":"乙"}],
              "passages":[{"ref":"1.1","source":1,"text":"10円（税抜）","offset":0}]}
        row={"label":"金額","left_ref":"1.1","right_ref":""}
        with patch.object(work_tools,"hub",return_value=data) as hub:
            work_tools.compare_quotes("sample",[row])
            cells=hub.call_args.args[1]["table"]["rows"][0]["cells"]
            self.assertEqual(cells[0]["text"],"10円（税抜）")
            self.assertIsNone(cells[1]["offset"])
            for ref in ("1.1","2.99"):
                with self.subTest(ref=ref), self.assertRaises(ValueError):
                    work_tools.compare_quotes("sample",[dict(row,right_ref=ref)])

    def test_group_filter_and_physical_rows(self):
        text = '\ufeff品名,処理,金額\r\n"青,紙",販売,"1,000.20"\r\n"青,紙",販売,0.10\r\n赤,返品,10\r\n"緑\n大",販売,8.05'
        conditions, totals, total, rows = work_tools.sum_csv(text,"金額","品名","処理","返品","")
        self.assertEqual(totals["青,紙"], Decimal("1000.30"))
        self.assertEqual(total, Decimal("1008.35"))
        self.assertIn("返品", conditions[-1])
        self.assertEqual(rows[2], {"label":"除外 ・ 4行目","text":"赤,返品,10"})
        self.assertEqual(rows[3], {"label":"採用 ・ 5行目","text":'"緑\n大",販売,8.05'})

    def test_invalid_input_never_silently_counts_as_zero(self):
        for text in ["品名,金額\n紙,不明", "品名,金額\n紙,1,2", "金額,金額\n1,2"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                work_tools.sum_csv(text,"金額","","","","")

    def test_only_selected_originals_and_missing_notice_fields(self):
        data={"passages":[{"ref":"1.1","source":1,"text":"対象者は営業部。","label":"資料"}]}
        with self.assertRaises(ValueError):
            work_tools.selected(data, ["1.2"])
        with patch.object(work_tools,"hub",return_value=data) as hub:
            work_tools.draft_document("this-test", ["1.1"], audience_ref="1.1")
            result=hub.call_args.args[1]
            self.assertEqual(result["evidence"][0]["text"], "対象者は営業部。")
            self.assertEqual(result["evidence"][1], {"label":"開始日","text":"記載なし"})
            self.assertEqual(result["evidence"][2], {"label":"必要な行動","text":"記載なし"})

