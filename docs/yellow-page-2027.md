# The yellow page: Mishlav study days 2027

The source: Mishlav's printed registration form ("הדף הצהוב"), photo in `yellow-page-2027.png`. It is what the
study days in Supabase `study_days` were seeded with (migration `20261124000000_study_days.sql`). From now on Mishlav
edits the days in the dashboard ("ימי עיון"). This page is the original, not what the bot reads.

## The study days

| Dates | Format | Topic | Hours | Lecturers | Place |
|---|---|---|---|---|---|
| 21+22.2.2027 (Sun+Mon) | Zoom | דיני עבודה + מס הכנסה | 10:00–13:15 | מיקי בן דב, אפי נדיב | Zoom |
| 17+18.3.2027 (Wed+Thu) | Zoom | ביטוח לאומי + ביטוח פנסיוני | 10:00–13:15 | שי עופרי, דנה להב | Zoom |
| 17.5.2027 (Mon) | Hotel | דיני עבודה + מס הכנסה | 9:00–16:00 | מיקי בן דב, אפי נדיב | מלון דן פנורמה, תל אביב |
| 21+22.6.2027 (Mon+Tue) | Zoom | מס הכנסה + ביטוח לאומי | 10:00–13:15 | אפי נדיב, בועז גבאי | Zoom |
| 20+21.7.2027 (Tue+Wed) | Zoom | דיני עבודה + AI ובקרות שכר | 10:00–13:15 | מיקי בן דב, הילה אהרוני | Zoom |
| 21+22.9.2027 (Tue+Wed) | Zoom | ביטוח לאומי + ביטוח פנסיוני | 10:00–13:15 | אורנה צח, שי עופרי | Zoom |
| 21.11.2027 (Sun) | Hotel | דיני עבודה + מס הכנסה + ביטוח פנסיוני | 9:00–16:00 | מיקי בן דב, אפי נדיב / אהרון ויזל, שי עופרי | מלון דן פנורמה, תל אביב |
| 20+21.12.2027 (Mon+Tue) | Zoom | דיני עבודה + ביטוח לאומי | 10:00–13:15 | מיקי בן דב, אורנה צח | Zoom |

A Zoom study day is ONE study day held in two meetings (the two dates), not two study days.

## Terms on the page

- Approved by the Institute of CPAs (לשכת רואי החשבון) as part of its training programme. Each study day = 7.5
  **academic** hours = 50% of the yearly requirement (academic hours, not clock hours).
- Price per participant: Zoom 313.5 ₪ before VAT (370 ₪ with VAT); hotel 669.5 ₪ before VAT (790 ₪ with VAT).
- Two study days or more: a 300 ₪ benefit toward a course at Mishlav college. No combining of discounts.
- Cancellation: up to a week before, a 60 ₪ handling fee; less than a week before, the full price.
- Switching to another study day: up to a week before the date; less than a week, not possible. No refund of the
  price difference.
- Company registration: the company's commitment form; payment by bank transfer or credit card only.

## Not on the page (TODO(mishlav))

- Course number of each study day (what the reps register in Gold).
- Purchase links.
- Detailed agenda; food at the hotel.
- Which days are "the same study day" (series). For example, 21.2 Zoom and 17.5 hotel have the same topic and
  lecturers. They are not linked until Mishlav says so (dashboard: "אותו תוכן כמו").
