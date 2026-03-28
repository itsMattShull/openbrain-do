# Professional CRM Extension

Track your professional network, log interactions, manage opportunities, and connect contacts to your Open Brain thoughts.

## What This Adds

| Tool | Description |
|---|---|
| `add_professional_contact` | Add a contact with company, title, email, tags, how_met |
| `search_contacts` | Find contacts by name, company, or tag |
| `log_interaction` | Record a meeting/call/email with optional follow-up; auto-updates last_contacted |
| `get_follow_ups_due` | Surface contacts needing follow-up within N days |
| `create_opportunity` | Track a deal/partnership/job through pipeline stages |
| `link_thought_to_contact` | Bridge: attach an Open Brain thought ID to a contact's record |

## Setup

This extension runs automatically on server start. Tables created:

- `professional_contacts` — your network roster
- `contact_interactions` — touchpoint log with follow-up tracking
- `opportunities` — deal pipeline (identified → exploring → proposal → negotiating → won/lost)

A database trigger automatically updates `last_contacted` whenever you log a new interaction.

## Example Prompts for Edith

- "Add Jane Smith at Acme Ventures, she's a VC I met at the conference last week"
- "Log a coffee meeting with Jane Smith, we discussed Series A timing, I need to follow up in 2 weeks"
- "Who do I need to follow up with this week?"
- "Create an opportunity with Jane Smith called 'Acme Ventures intro', stage exploring"
- "Link thought [UUID] to Jane Smith, this was context from our call"

## Interaction Types

`meeting`, `email`, `call`, `coffee`, `event`, `linkedin`, `other`

## Opportunity Stages

`identified` → `exploring` → `proposal` → `negotiating` → `won` / `lost`
