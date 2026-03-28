# Family Calendar Extension

Track family members, weekly schedules, and important recurring dates — all accessible through Edith.

## What This Adds

| Tool | Description |
|---|---|
| `add_family_member` | Register a household member with relationship, birthday, notes |
| `list_family_members` | View the full household roster |
| `add_activity` | Create a one-time or recurring weekly activity |
| `get_week_schedule` | Get the full schedule, optionally filtered to one person |
| `search_activities` | Query activities by keyword, type, or person |
| `add_important_date` | Record a birthday, anniversary, or deadline |
| `get_upcoming_dates` | Fetch dates coming up in the next N days (yearly events included) |

## Setup

This extension runs automatically when the server starts. The first run creates these tables:

- `family_members` — household roster
- `activities` — weekly schedule entries
- `important_dates` — birthdays, anniversaries, deadlines

No additional configuration required.

## Example Prompts for Edith

- "Add my wife Sarah as a family member, she's my spouse"
- "Add soccer practice for Jake every Tuesday at 4pm at Riverside Fields"
- "What does the schedule look like for this week?"
- "Add my mom's birthday, it's April 12th, remind me 14 days ahead"
- "What important dates are coming up in the next two weeks?"

## Activity Types

`sports`, `medical`, `school`, `work`, `social`, `other`
