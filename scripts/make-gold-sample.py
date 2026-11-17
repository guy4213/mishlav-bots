"""Build apps/backend/fixtures/gold-sample.xlsx: 10 FAKE students in the exact format of Mishlav's student export.

Same sheet name, 16 columns in the same order, same look (Arial 10, grey header, right-aligned, text-format ID and
phones). Every value is invented - names are common Hebrew names, emails are @example.com, ID numbers start with
0000 (never issued), and the phone numbers are made up: NEVER dial them.

Quirks of the real file are kept on purpose, for the Importer (Phase 4): an unnamed first column (a 20-char
record id), phones with spaces / no dash, landline numbers in phone 2/3, a city "Empty", trailing spaces in the
course name, notes that are Google links, notes that say when to call or not to call, and a [BOT] note.

Run: python3 scripts/make-gold-sample.py   (needs openpyxl: `uv run --with openpyxl python scripts/make-gold-sample.py`)
"""
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

OUT = Path(__file__).resolve().parents[1] / "apps" / "backend" / "fixtures" / "gold-sample.xlsx"

HEADERS = [None, "ת.ז", "חברה", "שם מלא", "אימייל", "טלפון", "טלפון 2", "טלפון 3", "הערות",
           "עיר", "כתובת", "כתובת 2", "מחלקה", "קורס מבוקש", "מקור", "סטטוס"]
WIDTHS = [17.1, 9.4, 16.9, 15.1, 9.2, 11.5, 21.2, 19.1, 30.9, 17.3, 17.7, 16.9, 17.0, 15.9, 19.4, 19.1]
TEXT_COLS = {2, 6, 7, 8}  # ת.ז and the phones are stored as text ("@"), so leading zeros stay

GOOGLE_NOTE = ('<a href="http://www.google.co.il/search?hl=iw&source=hp&q=%D7%99%D7%95%D7%9D+%D7%A2%D7%99%D7%95%D7%9F'
               '&meta=&aq=f&oq=">http://www.google.co.il/search?hl=iw&source=hp&q=%D7%99%D7%95%D7%9D+%D7%A2%D7%99%D7%95%D7%9F'
               '&meta=&aq=f&oq=</a>')

# record id | ת.ז | חברה | שם מלא | אימייל | טלפון | טלפון 2 | טלפון 3 | הערות | עיר | כתובת | כתובת 2 | מחלקה | קורס מבוקש | מקור | סטטוס
STUDENTS = [
    ["a000000000000001demo", "000012344", "שכר ופתרונות בע\"מ", "רועי כהן", "roi.cohen@example.com", "050-0000101", None, None,
     None, "תל אביב-יפו", "הרצל 12", None, "ימי עיון", "יום עיון חשבונאות", "אתר מישלב", None],
    ["a000000000000002demo", "000023457", None, "אורנה לוי", "orna.levi@example.com", "052-0000102", None, None,
     None, "רמת גן", "ביאליק 5", "דירה 4", "ימי עיון", "יום עיון חשבונאות", "googel adwords", "בוגר"],
    ["a000000000000003demo", None, None, "מיכל אברהם", "michal.a@example.com", "054-0000103", "03-0000103", None,
     "ביקשה שיחזרו אחרי 16:00", "חולון", None, None, "ימי עיון", "יום עיון דצמבר ", "facebook", None],
    ["a000000000000004demo", "000034561", "מפעלי הדגמה", "יוסי מזרחי", "yossi.m@example.com", "053 0000104", None, None,
     None, "פתח תקווה", "רוטשילד 30", None, "ימי עיון", "יום עיון מערכות סולאריות", "אינטרנט כללי", None],
    ["a000000000000005demo", None, None, "דנה פרץ", "dana.peretz@example.com", "050-0000105", None, None,
     GOOGLE_NOTE, "Empty", None, None, "ימי עיון", "יום עיון חשבונאות", "יבוא אקסל", None],
    ["a000000000000006demo", "000045674", None, "שי ביטון", "shai.biton@example.com", "058-0000106", "02-0000106", "08-0000106",
     None, "ירושלים", "יפו 101", None, "ימי עיון", "חשבי שכר", "המלצה/ חבר", None],
    ["a000000000000007demo", None, "חשבונאות דמו", "נועם אוחיון", None, "05000001070", None, None,
     "לא להתקשר יותר", "נתניה", None, None, "ימי עיון", "יום עיון חשבונאות", "Targets", None],
    ["a000000000000008demo", "000056788", None, "טל שפירא", "tal.shapira@example.com", "052-0000108", None, None,
     "[BOT] נשלח קישור ליום העיון", None, None, None, "ימי עיון", "יום עיון חשבונאות", "בוגר מישלב", "מתעניין"],
    ["a000000000000009demo", None, None, "אבי דהן", "avi.dahan@example.com", "054-0000109", None, None,
     None, "באר שבע", "העצמאות 7", None, "ימי עיון", "יום עיון חשבונאות", "פורטל מכללות", None],
    ["a000000000000010demo", "000067892", "ייעוץ שכר דמה", "רונית גבאי", "ronit.g@example.com", "050-0000110", None, None,
     "כבר נרשמה לנובמבר 2026", "חיפה", "הנביאים 3", None, "ימי עיון", "יום עיון נובמבר", "שיווק sms", None],
]


def main() -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "תלמידים"
    font = Font(name="Arial", size=10)
    right = Alignment(horizontal="right")
    grey = PatternFill(fill_type="solid", fgColor="FFF0F0F0")
    for c, (h, w) in enumerate(zip(HEADERS, WIDTHS), start=1):
        cell = ws.cell(1, c, h)
        cell.font, cell.alignment, cell.fill = font, right, grey
        ws.column_dimensions[cell.column_letter].width = w
    ws.row_dimensions[1].height = 12.75
    for r, row in enumerate(STUDENTS, start=2):
        assert len(row) == len(HEADERS), row[3]
        for c, v in enumerate(row, start=1):
            cell = ws.cell(r, c, v)
            cell.font, cell.alignment = font, right
            if c in TEXT_COLS:
                cell.number_format = "@"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    wb.save(OUT)
    print(f"wrote {OUT} ({len(STUDENTS)} fake students)")


if __name__ == "__main__":
    main()
