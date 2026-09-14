// ask-beacon -- Supabase Edge Function. Kyle / Imogen, 13 Sep 2026.
//
// WHAT IT DOES: answers a question about USING Beacon, from the guide below
// and nothing else, then logs the question and answer as the caller.
//
// WHAT IT NEVER DOES: read a trip, a leg, a schedule or a note. The only
// data that leaves the building is the person's own question and the guide.
// That is why this does not wait on the ServiceNow / AI approval that
// extraction waits on: nothing prohibited under GSP-8301 is sent.
//
// AUTH: same shape as extract-trip-document. Refuse anonymous callers
// before reading the body; build a client FROM THE CALLER'S TOKEN so every
// read and the log write go through RLS. No service role anywhere here.
//
// MODEL: claude-sonnet-5. Do NOT move this to a Fable-class model -- those
// require 30-day retention and are excluded from ZDR (beacon-zdr-route.md).
//
// THE GUIDE lives in this file, stamped with the build it describes. When a
// build changes something a person sees, the guide changes in the same
// build and this function is redeployed (beacon-OPERATING-RULES.md, section 4).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const GUIDE_VERSION = "2026-09-14T15:10:00Z";
const MODEL = "claude-sonnet-5";
const MAX_QUESTION_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 20; // ten exchanges; the front end sends the same cap

const GUIDE = `# Ask Beacon — the guide

**Describes build \`2026-09-14T05:50:00Z\`.** Rewritten 14 Sep 2026 from a screen-by-screen read of the whole file — every view, every control, every dialog and its wording. Per the operating rules, any build that adds, removes, renames or re-gates something a person sees on screen updates this guide in the same build and re-stamps this line.

This is the only thing the Ask Beacon assistant knows about Beacon. If it isn't in here, the honest answer is "I don't know that yet — send it as feedback."

---

## 0. How to answer

- Answer only from this guide. If the guide doesn't cover it, say so plainly and suggest Send feedback. Never guess at a control that isn't described here.
- Help with **using Beacon**, not with the person's trip. Ask Beacon cannot see any trip, leg, schedule or note. If someone asks "is my leg ready?" say that you can't see their data and tell them where to look.
- Answers are scoped to the person asking. Admin-only controls are marked **(admin)** below. If a non-admin asks why they can't see one, say it's an admin control and to ask an admin of their department.
- Plain language. Use Beacon's own names for things (Crew Brief, Trip Plan, the checklist, the board) so what you say matches the screen.
- Short. One or two sentences where that answers it. The person is often on a phone, possibly hearing this read aloud.
- Questions are saved so we can see where Beacon is confusing and fix it. Feedback is only sent when the person taps Send feedback; nothing goes anywhere on its own.
- Speak as "we" for the people who build Beacon. Never name anyone.

---

## 1. What Beacon is

Beacon is a Part 91 flight-operations app for one flight department. It holds trips and their legs, who is flying them, the aircraft, the schedule, shared notes, airport briefs, and the paperwork behind each trip. Its rule of thumb: **readiness first, knowledge forever** — get every leg to Ready before it flies, and keep the record afterwards.

**Beacon is in beta and is not approved for operational use.** The released paperwork remains the record. The Terms you accepted say that plainly, and they also say: do not upload real trip paperwork, another operator's documents, or any passenger information — use fabricated or sanitised documents for testing. A "verified" tick in Beacon records only that a person looked at that item in a test application; it is not a dispatch release or a regulatory sign-off.

You sign in with an email and password. Your account belongs to one flight department. If you sign in and see *"You are not in a flight department"*, your sign-in worked but an admin has not added you to a department yet — ask them.

There are two kinds of people: **crew members** and **admins**. Admins add and remove people, reset passwords, add and retire aircraft, build and delete trips, add legs, write to the schedule, archive trips, and change department settings. Everyone else can read everything in the department, edit legs, verify sections, set leg status, write notes and briefs, attach documents, and link chats. Some people are marked **Contractor**; contractors cannot be given admin access.

Job titles are **Pilot**, **Dispatcher**, **Cabin crew** (flight attendant) and **Maintenance**. Titles decide who appears in which crew slot. They are not editable in the app.

Beacon runs in the browser and can be installed to a phone or computer home screen (Menu → Install on a device). There is no app store version.

---

## 2. The shape of every screen

**The bottom bar** is on every screen once you're signed in. Left to right: **Home**, **Trips**, **Schedule**, **Chat**, **Notes**, then a divider, then **Refresh** and **Menu**.
- Home, Trips and Schedule change the screen.
- Chat and Notes raise a panel over whatever you're on.
- Refresh reloads the data from the server. If something looks stale, or you were told a change was made and can't see it, Refresh is the first thing to try.
- Menu opens the drawer (section 3).

**The header** sits at the top on most screens (not on Home). It carries the page title, a **Back** control on the left, and on the Trips, Crew Brief and archive screens your department's name. On the Crew Brief and the leg checklist a **paperclip** sits at the right with a count — tap it to jump to that page's documents.

**The Ask Beacon bubble** is a small round speech-bubble button on the line under the header, toward the right. Tap it and this assistant slides up over the page.

**Back** takes you back to where you came from, not to a fixed place. The label names it — *Active Trips*, *Trip Plan*, *Schedule*.

**Sheets and dialogs** — many actions raise a panel from the bottom or a box in the middle. Tap × or the dark area outside to close. Nothing is saved by closing unless you tapped its confirm button.

**Toasts** — short messages at the bottom of the screen confirm a save or explain a refusal (*Only an admin can add legs*).

---

## 3. The Menu drawer

Menu (bottom bar, far right) opens a drawer with:
- **Home**
- **Settings** — section 12.
- **Send feedback** — a form with a type (**Idea / request**, **Something's broken**, **General comment**) and a text box. This is how you reach us.
- **Install on a device** — a QR code another device can scan to open Beacon, a link to copy and send, and the steps to add Beacon to a home screen: iPhone/iPad — Share icon then *Add to Home Screen*; Mac Safari — File menu then *Add to Dock*; Mac or Windows Chrome — the install icon in the address bar (or menu → *Cast, save, and share* → *Install page as app*).
- **Legend** — explains the colours, rings, dots and the schedule tally. Section 13 repeats it.
- **Terms of Use** — re-read the interim terms you accepted on first sign-in.
- **Delete leg** — appears only while a leg checklist is open. It deletes that one leg. Deleting a whole trip is done from the Trip Plan (section 6), not here.
- **Undo delete** — appears only after you delete a leg, and names what it brings back. It lasts until you close the app. Deleting a trip has no undo.
- **Log out**
- Under the heading **Manual entry**: **Create a trip by hand** — starts an empty leg you fill in yourself. Most trips arrive as paperwork (section 7); use this only when there is none.

---

## 4. Home

Home shows the Beacon mark and three buttons:
- **Active Trips** — with a count. Opens the board (section 5).
- **Archived Trips** — with a count. Opens the archive (section 9).
- **Read Trip Paperwork** — *New trips or revisions*. This is the AI door: choose a PDF and Beacon reads it into a draft trip or a set of changes to an existing one (section 7).

"Active" means **not archived**. A trip whose legs have all flown stays active, on the board, until an admin archives it.

---

## 5. Trips — the board, the trip card, and the two doors

### The board (Active Trips)
A search box (*Search missions by route, airport, trip #...*) and a grid of trip cards. Search matches trip number, leg number, city pair and airport codes. Back goes to Home.

### The trip card
Each card shows: **Trip** number; the routing as a chain of airports (*KBDL → KTEB → LEMD*); one **status dot per leg**, numbered, coloured for Planning / Ready / Flown; a line like *3 legs • 2 planning, 1 ready*; the date range; and, if you are seated on any leg of the trip, your **crew abbreviation** as a small badge (*You are crewed on this trip*). A trip with every leg flown but not yet archived is banded **FLOWN · AWAITING ARCHIVE**. A trip with no trip number on its paperwork is labelled so — Beacon grouped those legs by route and date.

At the foot of the card are two buttons, named for the screens they open:
- **Trip Plan** — the workbench (section 6). If the trip has no plan yet, tapping this creates one and opens it.
- **Crew Brief** — the flying view (section 5, below).

An archived trip's card reads **Sealed record** instead.

### Crew Brief (the trip page)
The header reads **Crew Brief**; a paperclip at the right jumps to the trip's documents. Under it is a sticky **strip**: **Trip**, **Leg**, **Tail**, and the crew seats as abbreviations (**PIC**, **SIC**, then ACM and cabin crew if seated). The strip is read-only — crew is assigned on the Trip Plan — and it follows the leg you scroll to.

Then one **band per leg**, in leg order. A band shows the **LEG** number (tap it to show that leg in the strip), the route, the date, the status pill, *N items pending* if any (see below), who last edited it, a paperclip badge with that leg's document count, and:
- **Airport brief** (top right) — opens a chooser for the leg's two airports so you can read what the department has written about either (section 10). If the leg has no airports entered yet, it says so.
- **Open checklist** — opens the leg (section 8).
- **Set status** — opens the status sheet (section 8, *Status*).

**Items pending** counts things the leg says it needs but hasn't got: a slot answered Yes with no slot time; a landing permit answered Yes with no details; EAPIS or customs answered Yes with no details; ground transport answered Yes with no details; a ramp-fee waiver with no minimum gallons; overflight permits with countries not yet confirmed.

Below the bands: **+ Add leg (admin)**; the **Notes** door (*View all N notes on this trip, or add one*; a trip needs a trip number to carry notes); the **Documents** block (**+ Add document** — PDF or image; each has View, Download, Delete); *Edited by … · Review history* which opens who-changed-what for the trip; and, for admins, **Archive trip** with a hint — *All legs flown. Archiving seals this trip permanently.* or *N of M legs not yet flown. This trip can still be archived, but will be permanently marked incomplete.*

### Assigning crew or a tail from a leg
From a Trip Plan leg row, **Change crew** and **Change tail** open a small sheet for that one leg. The crew sheet shows a picker per seat; the tail sheet a picker of the department's aircraft (**Remove aircraft** / **Clear aircraft** where that applies). Before it applies, the sheet shows what will change. On an archived trip the sheet says the trip is a sealed record and there is nothing to change.

---

## 6. Trip Plan (the workbench)

The Trip Plan is where a trip is built. Reached from a card's **Trip Plan** button or from the Schedule's Trips panel. Back goes to wherever you came from. **Only an admin can build a trip**; everyone else reads it.

From the top:
- **Trip overview** — *Changes here post to the schedule grid.* **Start date**, **End date**, **Routing** (e.g. *BDL-TEB-LEMD*), **Notes**. *Changes save as you leave each field.*
- **Crew** — a picker per seat: **PIC**, **SIC**, and **+ ACM** / **+ Cabin crew** to add more seats. People on the plan but not yet seated are listed as *Not yet seated*. A person who isn't available shows *(unavailable)*.
- **Days on the trip** — per person, which days of the trip they are on. Default is *The whole trip*. **Change** lets you set **From** / **To** dates and optionally **From leg** (a number; blank means all day), which is how you record **cover** for part of a trip — the row then reads *PIC cover* (or the seat covered) with the range. × removes a range. A day with no one in a seat reads *No PIC on …*.
- **Positioning days** — days someone travels without flying. **+ Positioning day** adds a date; on each day **+ Person** adds who, **Remove day** removes it. *Nobody on it yet* shows until someone is added. Tapping a person on a positioning day opens the **Positioning** page (section 11).
- **Aircraft** — **Tail** picker from the department's aircraft, with optional **From** / **To** dates so a trip can change aircraft partway. **Take off this trip** removes it. A second aircraft can be added once the first is chosen.
- **Leg details** — a sentence saying whether Smart Schedule is on (*Changes here will post to the schedule grid*) or off. Then the legs as rows: **Leg N · route · date**, each with **Change tail**, **Change crew**, **Open full leg** (opens the checklist; Back returns here) and × to delete the leg. **+ Add leg (admin)**.
- **Link trip numbers** — *Tie this trip to another trip number, so crew can see they're part of the same journey.* Reads **Change link** once set; the dialog has **Remove link**.
- **Push to active trip** — reads *N things on the legs this plan can fill in or correct* or *The legs already match this plan*. Pushing fills empty seats and blank tails on the legs from the plan; where a leg already says something different, it asks which one is right. It never silently overwrites.
- **Delete this trip (admin)** — in the header. The dialog says: *This deletes the trip for everyone — the plan, all N legs, and everything added to them. It comes off the schedule. This cannot be undone.*

---

## 7. Read Trip Paperwork

Home → **Read Trip Paperwork**. **Choose a PDF** (PDF only). *Beacon reads your paperwork with Claude. You receive a draft, not a decision. Nothing lands on your board until you say so.* The page shows *Powered by Claude*.

While it reads you see a progress line. Then a preview, grouped as:
- **New legs to add (N)** — cards you can tick or untick. A **Renumber these legs 1–N** switch uses Beacon's own numbering instead of the document's; what the paperwork called each leg is kept so a revised sheet still lands on the right leg.
- **Existing legs to update (N)** — where the document matches legs already on the board, the changes it would make.
- **Legs to remove (N)** — legs on the board the revised sheet no longer has.
- **Needs review (N)** — things Beacon could not match confidently.
- **Already on your board (N)** — legs the document duplicates (same departure, arrival and date); nothing new is created for those.

**Select all** / **Select none** per group; *Will apply: …* summarises your picks. **Confirm and apply** lands it; **Cancel** discards everything. If the document matches the board exactly it says so and there is nothing to apply. If it can't read the file: *Couldn't tell what kind of document this was* and **Try another file**.

Values that come from paperwork show **cyan** on the checklist until a person verifies them (section 13). The extraction refuses passenger names by design.

**If reading paperwork is switched off for your department** (an admin setting, section 12), this page says so and points you to **Create a trip by hand** in the Menu. Everything else in Beacon works the same.

---

## 8. The leg checklist

Open from a Crew Brief band (**Open checklist**) or a Trip Plan leg (**Open full leg**). The sticky strip at the top shows **Trip**, a **leg navigator** (‹ *N of T* ›) to step between the trip's legs, **Tail**, and the crew abbreviations. The header carries a **progress pill** — *3 of 9 checked*, or **CHECKLIST COMPLETE** — that counts **your own** sign-offs; tap it to jump to the next section you haven't checked.

### The nine sections, in order, with their fields
1. **Departure** — Airport ID, Departure date, UTC offset (*auto* unless you type one), ETD local, ETD Z (UTC), Hours of operation, Dep slot req'd (Y/N) with Slot time / number and Slot time allowance (*+ / -*), Handling agent, Phone number, ARINC Frequency, Fuel vendor, Fuel price, Payment method, Ramp fee, Waived w/ fuel (Y/N), Min GAL to waive. Then the **KBDL Scratchpad** (named for the airport once a code is entered; *Departure Scratchpad…* before that).
2. **Arrival** — the same set for the arrival end (Arrival date, ETA local, ETA Z, Arr slot req'd, …) and the **KFOK Scratchpad**.
3. **Permits** — four cards, each with a Required (Y/N) and Details: **EAPIS**, **Customs landing rights**, **Landing permit / PPR**, **Overflight permits**. Overflight has **+ Add country** and a row per country to confirm.
4. **Dispatch** — FRAT / release (Y/N).
5. **Performance** — Trim, Level off altitude, Min required fuel.
6. **Enroute** — Max shear, ETE, Headwind / Tailwind (HW / TW toggle with a value), Relative time to destination (*auto*), and the **Enroute Scratchpad**.
7. **Pax** — the title carries the count from the paperwork (*Pax 4*). **Pax remarks** (*Catering, mobility assistance, pets, extra baggage…* — deliberately not passenger names), and **Ground transport arranged** (Y/N) for each end.
8. **Crew** — **Crew remarks** (*Hotel, rental car, crew transport…*).
9. **Next pax leg** — Destination, Date, Day (*auto*), ETD, ETA. These pre-fill from the next leg on the trip that carries passengers.

Below the sections: the **Notes** door (*Pinned to this leg* or *On this trip*), the **Documents** block for the leg (**+ Add document**, PDF or image; View, Download, Delete), and *Edited by … · Review history*.

### Y/N toggles
Answering **No** on a slot question fills the slot fields with *NA* for you. A toggle keeps its red (Yes — something is required) or green fill whatever its source; only the letter goes cyan if it came from paperwork.

### Two "please check" flags
- Hours of operation carried across an overnight stop show *Carried from the other end of this stop — different day, please check*. Typing in the field, or verifying the section, clears it.
- Next pax leg fields show *Trip sheet says X — please check* when what's stored differs from what the paperwork says. Beacon flags, it never overwrites a value a person entered.

### Scratchpads
Three private pads: one on Departure, one on Arrival, one on Enroute. **Private means private** — nobody else in the department sees yours, not an admin, not the other pilot, and they are never archived. They're for reminders to yourself. There is no share control on them. Anything the department needs to keep goes in Trip notes, Airport briefs, or the leg's own fields.

### Verifying — per person
Each section title has a **verify button** that reads the section's own name (*Departure*) until you tap it, then reads **Checked** with a tick, and the section gets a **green outline**. That is *your* sign-off. Other people's sign-offs on the same section appear underneath as *Verified by …*. Under the title a line says who last touched the section and when (*Last touched by … · 2 hours ago*, or *Imported*).

Editing a field after you signed it off turns it **amber** with a *changed since verified* tag, removes your tick, and the button goes back to the section's name — check it again and re-verify. Merely opening a leg to read it never removes anyone's sign-off; only a real edit does. Nothing automated can verify a section.

### Status
Three statuses: **Planning** (still being built), **Ready**, **Flown**. Set from **Set status** on the Crew Brief band, the Trip Plan, or the status select on the checklist.
- **Ready is earned.** All nine sections must be verified (by someone) first. Trying earlier says *All sections must be verified before this leg can be set to Ready.*
- **Flown** is gated the same way — a leg can't jump from Planning to Flown.
- A fully verified leg can't be hand-set back to Planning; to move it back, reopen the one section that needs work by editing it. Blocked rows in the status sheet stay tappable, explain why, and offer **Open checklist**.
- A flown leg stays on the board and stays editable until the trip is archived.

### Changed since you last looked
If someone else edited the leg since you last opened it, a box shows what moved, who moved it, and what it was before. Advisory only — nothing is blocked. **Got it** dismisses it. It never reports your own edits to you, and nobody can see what you've read.

**History** on the leg (and **Review history** on the trip): every change, with who and when.

---

## 9. Archived trips

Home → **Archived Trips**, or the board's archive. A search box (*Search past trips by route, airport, trip #...*) and a card per trip: **Trip** number, leg count, when it flew, *Archived …*, **Sealed record**, and **ARCHIVED INCOMPLETE** if legs were unflown.

Archiving is **per trip, by an admin, and cannot be undone**. It freezes the trip as it stood: every field, who verified what, the crew in each seat, shared notes and documents. A trip never archives itself; flown legs sit on the board until an admin decides the record is finished.

The archived trip page reads *Archived* (or *Archived incomplete*), *Sealed by … on …*, then a read-only card per leg (*Read only · tap to view*), **Notes at archive time** (*Private notes were not captured. Only notes shared with the flight department appear here.*), and **Documents at archive time**. An archived leg opens read-only: *This leg is part of a sealed trip record. Values are shown as they stood when the trip was archived.* Phone numbers that start with + are tappable to dial.

---

## 10. Schedule

One year at a time. The header has ‹ **Today** › for months and a **year chooser** (a pill; tap it and pick a year). There's no month label in the header — the month band in the grid names what you're looking at as you scroll.

**Rows** are people (grouped by job title) and aircraft. **Columns** are days. Coloured blocks are entries; trips paint themselves on the crew and tail rows when Smart Schedule is on.

**Tap a day** (or drag across days) on someone's row to open the entry panel for those dates. Everyone can open it and read what's on that day. **Only an admin can add, remove or shorten** — for non-admins it is read-only. Nothing is pre-chosen: pick the dates, pick a category, then **Add**. Categories for a person: **Training**, **PTO**, **Quarterly call**, **Soft day**, **Other**, **Info only**. For an aircraft: **In maintenance**, **Other**, **Info only**. **Details** is required for some categories and optional for others; an **Emoji** is optional. Existing entries on that day are listed with **Remove** (*The whole block is removed, not just this day*) and **Shorten**.

**Info only** means "there may be something to ask about" and is not a duty — on a crew row the person may have another obligation; on a tail row the aircraft may.

Dragging a span onto a trip that already exists asks **Add to this trip?** — **Merge** (stretch or join the existing trip) or **Create Trip** (a new one) or **Cancel**.

**Training** entries open an event page: **Who**, **What**, **When**, **Details**, **Emoji**, **Location**, and **Arrangements** (Hotel, Rental car, Flights, Notes). Only an admin changes the event itself; the person on it can fill in their own arrangements.

**The Trips button** (labelled with the month on screen, e.g. *September Trips*) opens a panel over the grid listing that month's trips like the master spreadsheet: **Tail, Routing, Start, End, Days, PIC, SIC, FA, Notes**. Empty cells are the to-do list. Tap a row to open its Trip Plan. **+ Trip (admin)** starts a new plan.

**The tally column** (far right of each crew row) shows **Duty Ave** — duty days above or below the average for your own job title, pilots and cabin crew averaged separately, worked out per day you were available. A dash means nothing to compare against yet. The arrow at the top opens the detail: **Duty**, **PTO** and **Home**, each for the month and the year. Home is every available day that is not duty; PTO sits inside home. A tail reads **Away** and **Maint** instead. One day is only ever counted once; where a day is both, duty wins.

**Smart schedule (admin setting)**: when on, Beacon fills in flight duty days (every day a leg touches) and away days (days in the middle of a trip when nobody flies) from the trips it holds, and Trip Plan dates post to the grid. Anything entered by hand is left alone. When off, the schedule shows only what someone entered by hand.

---

## 11. Positioning

Reached from a person on a positioning day on the Trip Plan. Shows **Who**, **Trip**, **When**, and **Arrangements**: **Hotel**, **Rental car**, **Flights**, **Notes**. The person themselves or an admin can edit; **Remove from this day** takes them off it. Back goes to the Trip Plan.

---

## 12. Notes, airport briefs and chat

### Notes (bottom bar)
Tapping **Notes** raises a quick-note sheet: a list of live trips, **Add note** on each, a text box and **Post**. A trip needs a trip number before notes can be added. *Notes are shared with everyone on the trip.* It also opens the Notes page with two tabs:
- **Trip notes** — pick a **Trip**, optionally **Pin to** a leg (or *Whole trip*), write, **Post**. A note starts **Shared** (*Shared with the flight department unless you say otherwise*); tap the visibility button to make it **Private** (*Private to you — tap to share*). Shared notes carry your name and are archived with the trip; private ones are yours alone and never archived.
- **Destination notes** — airport briefs (below).

### Airport briefs
Also reached from **Airport brief** on a Crew Brief band, which lets you pick either end of the leg. Enter a four-letter **ICAO** identifier; Beacon shows the airport's name if it knows it (an unknown code still works — the bundled database isn't complete).

Three subjects, as tabs:
- **Airport** (*Airport operations*) — handlers, fuel, customs, flight plan processing.
- **City** (*City recommendations*) — where to eat, hotels to avoid, getting around.
- **Cabin** (*Cabin reference*) — catering, provisioning, FBO services.

Each has a **body** (*What happened here…* / *What you found here…*) and an optional **Advice to future crews** (*— optional, and the future crew might be you*). Before you **Post**, two buttons: the **source** toggle — **I saw this** (Observed) or *passed on to you* (Heard) — and the **Shared / Private** toggle. Posted briefs list newest first with the author, their job title, Observed or Heard, *Private* if so, and a × to withdraw your own. Under the briefs, **Files** — **+ Add document** (PDF or image) attached to that airport.

### Chat
**Chat** raises a sheet listing live trips. Each can have one group chat linked: **Link a chat**, paste the group invite link (WhatsApp, Signal, Telegram or another), **Save**. Then **Open WhatsApp** (or whichever) opens the group in the other app; **Remove** takes the link off. *Messages stay there — they are not part of the trip record.* If the link isn't a group invite, Beacon says how to get one (in WhatsApp: open the group, tap its name, Invite via link).

---

## 13. Settings (Menu → Settings)

- **Your account** — **Display name** (yours to change; *What other crew see next to anything you write*) with **Save**. Your **Crew abbreviation**, **Job title** and **Email** are shown read-only — they identify you on trip documents, so an admin sets them.
- **Aircraft** — the list tails are chosen from when you build a leg. Each row shows the tail, an editable **Aircraft type (admin)**, and **Retire** / **Restore (admin)**. Retired reads *Retired — hidden from the tail picker*; the tail stays on any leg that already has it. **Add aircraft (admin)**: type the tail (e.g. *N667BB*).
- **People** — the roster grouped by job title (Pilots first), each with name, abbreviation, email, title, and a **Contractor** badge where set. **Add person (admin)**: email, display name, job title, four-character crew abbreviation, legal given name and surname (*As printed on trip documents. Both legal names are required: they are how extracted crew are matched to accounts*). Creating shows the new account's password **once** — copy it or write it down. **Edit (admin)**: the same fields plus **Hire date** (only needed for someone hired during the year being counted — blank means counted from 1 January), **Admin access** (give or remove; not available for contractors), and **Remove** from the department (keeps their login; crew already recorded on past legs is not affected). **Reset password (admin)**: generates a new one, shown once; the old password stops working immediately.

**Crew abbreviations are for life.** Four letters or numbers, chosen by the department, unique within it. When a person is removed from the department their abbreviation stays taken — it is not freed for reuse, and there is no control to free it. Every archived leg that shows that abbreviation in a seat has to keep meaning the same person. If someone asks whether they can give a departed colleague's letters to a new hire: no. Removing a person also cannot be undone from inside the app — there is no way to add them back yet, because adding a person needs a new email address. And a department's last admin cannot be removed or have admin access taken away; make someone else an admin first.
- **Smart schedule (admin switch)** — *Smart* or *Manual*; see section 10. Applies to everyone in the department.
- **Reading paperwork with AI (admin switch)** — **On**: Read Trip Paperwork sends the PDF you choose to Claude, which returns a draft. **Off**: no document leaves Beacon for AI; the Home button still appears but explains it is off. Attaching a document to a trip or airport is not affected either way — those files are stored, not read by AI. *Some companies require approval before this is used.*
- **Fields and verification** — marked **Coming soon**. Not built: departments will set which fields are required and people will be able to hide fields they never use.

---

## 14. What the colours mean (the Legend)

- **Status dots / pills**: **Planning** — still being built; **Ready** — every section verified by a person; **Flown** — flew, stays on the board and editable until archived.
- **Cyan text** — read out of paperwork you uploaded; nobody has confirmed it. Read it against the source. **White** — a person owns it: typed it, or read the extracted value and verified it. Verifying turns cyan to white. On a Yes/No toggle the button keeps its red or green fill; only the letter turns cyan.
- **Green outline** — verified (on the whole card for Airports, Permits, Pax; on the field elsewhere). **Amber outline + "changed since verified"** — edited after sign-off; check and verify again.
- **Changed since you last looked** — a count of changes since you last opened the leg; advisory.
- **Sealed** — archived, read-only.
- **Shared / Private** notes — shared: everyone reads it and your name is on it; private: yours alone, never archived.
- **Duty Ave, Home, Away, Maint** — section 10.

---

## 15. Ask Beacon itself

The bubble opens a panel over the current page. It has a few suggested questions for the screen you're on, a **mic** (tap to talk, tap again to send — it keeps listening until you do, so pauses are fine; the answer is read aloud), a text box with **Ask**, and under a line, **Send feedback**. Voice is the normal way to use it; the box is for when you can't speak. Your questions are saved so we can see where Beacon is confusing and fix it; feedback is only sent when you choose to send it. Ask Beacon reads no trip data — only the answer text goes to the speech service, never your question or anything from your trips.

---

## 16. Not in Beacon yet

If asked about any of these, say it isn't built yet and suggest Send feedback:
- Pilot wallet / your own documents and expiry dates (medicals, passports, licences)
- Open items / a "what's outstanding for me" list
- Push notifications (Beacon can't notify you when something changes; check the board)
- Department logo in the header
- Native iPhone/Android app; hands-free Ask Beacon without tapping
- Crew agreements to sign
- Per-department field rules and hiding fields (Settings shows it as Coming soon)
- Exporting or deleting a whole department's data
- Concurrent-edit protection: if two people edit the same leg at once, the later save wins

---

## 17. Conversation starters by screen

**Home** — How does Beacon read my trip paperwork? · What's the difference between active and archived trips? · How do I install Beacon on my phone?
**Board** — What's the difference between the Crew Brief and the Trip Plan? · What do the status dots mean? · How do I find a trip by airport?
**Crew Brief** — How do I open a leg's checklist? · What is an airport brief? · Who can archive a trip?
**Trip Plan** — How do I add cover for part of a trip? · What does Push to active trip do? · What is a positioning day?
**Checklist** — Why is this text cyan? · What does changed since verified mean? · When does a leg become Ready?
**Schedule** — What does Duty Ave mean? · What does Smart Schedule do? · How do I add PTO?
**Training event** — What is a training event for? · Who can edit the details on this page?
**Positioning** — What is a positioning day? · Who can see the travel details I put here?
**Notes** — What's the difference between a trip note and a scratchpad? · Who can see the notes I write?
**Archived Trips (list) and an archived trip** — Can an archived trip be edited? · What does ARCHIVED INCOMPLETE mean? · Where are the private notes?
**Settings** — How do I reset someone's password? · What does retiring an aircraft do?

---
`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---- 1. Who is calling? -------------------------------------------
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) {
      return jsonResponse({ error: "Not signed in. Sign in again and ask once more." }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY are not available to the function");
    }

    const sb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Your session has expired. Sign in again and ask once more." }, 401);
    }
    const userId = userData.user.id;

    // ---- 2. Which department, and is the caller an admin? ---------------
    // RLS returns only the caller's own membership rows. Admin status shapes
    // the answer (admin-only controls are explained, not hidden). The
    // department id is where the question is logged. A person in no
    // department gets an answer -- the guide covers that screen -- but the
    // question cannot be logged anywhere, and that is said in the response.
    const { data: mems, error: memErr } = await sb
      .from("memberships")
      .select("flight_department_id, is_admin")
      .eq("user_id", userId);
    if (memErr) {
      throw new Error(`Could not read membership: ${memErr.message}`);
    }
    const membership = Array.isArray(mems) && mems.length ? mems[0] : null;
    const isAdmin = !!(membership && membership.is_admin);

    // ---- 3. The question ------------------------------------------------
    const body = await req.json().catch(() => ({}));
    const question = String(body?.question || "").trim().slice(0, MAX_QUESTION_CHARS);
    const screen = String(body?.screen || "").slice(0, 40);
    const buildVersion = String(body?.buildVersion || "").slice(0, 40);
    if (!question) {
      return jsonResponse({ error: "No question received" }, 400);
    }

    // The conversation so far, held by the browser for the session and sent
    // back each time. Nothing here is trusted as-is: roles are checked, text
    // is clipped, the count is capped, and it must alternate user/assistant
    // ending on assistant so the new question can follow. Anything malformed
    // is dropped whole rather than repaired -- a bad history is worth less
    // than none. Only the new question and answer are logged.
    let history: { role: "user" | "assistant"; content: string }[] = [];
    if (Array.isArray(body?.history)) {
      const raw = body.history.slice(-MAX_HISTORY_MESSAGES);
      const cleaned: typeof history = [];
      let ok = true;
      for (let i = 0; i < raw.length; i++) {
        const m = raw[i];
        const role = m?.role === "user" || m?.role === "assistant" ? m.role : null;
        const content = String(m?.content || "").trim().slice(0, MAX_QUESTION_CHARS);
        const expected = i % 2 === 0 ? "user" : "assistant";
        if (!role || role !== expected || !content) { ok = false; break; }
        cleaned.push({ role, content });
      }
      if (ok && cleaned.length % 2 === 0) history = cleaned;
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set in Edge Function secrets");
    }

    // ---- 4. Ask -----------------------------------------------------------
    // The voice. The rules below the guide (answer only from it, no data, admin
    // scope, short) are what keep it honest. This part is what keeps it from
    // sounding like documentation read aloud. The test Kyle set: would someone
    // tap the bubble a second time.
    const system =
      "You are Ask Beacon, the help built into Beacon, a Part 91 flight-operations app. " +
      "Talk like someone who builds Beacon explaining it to a colleague in the crew room: warm, direct, plain. You speak for the people who build Beacon, so say we and never name anyone. " +
      "Lead with the answer, then the one thing worth adding, then stop. Two or three spoken sentences is usually right; one is fine. " +
      "Use Beacon's own names for things so what you say matches the screen. " +
      "It is a conversation: if there is a previous turn, build on it rather than starting over, and if the question is ambiguous, ask one short question back instead of covering every case. " +
      "Contractions are good. Never open with a restatement of the question, an acknowledgement, or a headline. Never list, never number, never use markdown. " +
      "Everything you say is read aloud, so write for the ear: no symbols, no arrows, no parentheses. " +
      "\n\nWhat keeps you honest: answer only from the guide below. If it isn't there, say you don't know that yet and that Send feedback at the bottom of this panel reaches us. Never invent a control. " +
      "You cannot see the person's trips, legs, schedule or notes. If they ask about their own data, say so in one sentence and tell them where in Beacon to look. " +
      `The person asking is ${isAdmin ? "an admin of their department" : "a crew member, not an admin"}; controls marked admin in the guide are ${isAdmin ? "theirs to use" : "not theirs, and you should say so plainly and suggest they ask an admin"}. ` +
      (screen ? `They opened Ask Beacon from the screen Beacon calls "${screen}", so that is probably what they are looking at. ` : "") +
      "\n\n=== THE GUIDE ===\n\n" + GUIDE;

    const started = Date.now();
    const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: system,
        messages: [...history, { role: "user", content: question }],
      }),
    });
    const latencyMs = Date.now() - started;

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      throw new Error(`AI API error: ${aiResponse.status} ${errText}`);
    }
    const aiData = await aiResponse.json();
    const answer = (aiData?.content || []).map((b: { text?: string }) => b.text || "").join("").trim();
    const inputTokens = aiData?.usage?.input_tokens ?? null;
    const outputTokens = aiData?.usage?.output_tokens ?? null;

    // ---- 5. Log, as the caller ------------------------------------------
    // A failed log does not lose the answer: the person asked a question and
    // gets it answered. The failure is reported alongside so it is not silent.
    let logged = false;
    let logError: string | null = null;
    if (membership) {
      const { error: insErr } = await sb.from("ask_beacon_questions").insert({
        flight_department_id: membership.flight_department_id,
        user_id: userId,
        screen: screen || null,
        build_version: buildVersion || null,
        guide_version: GUIDE_VERSION,
        question,
        answer,
        model: MODEL,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: latencyMs,
      });
      if (insErr) logError = insErr.message; else logged = true;
    } else {
      logError = "not in a flight department";
    }

    return jsonResponse({ answer, logged, logError, guideVersion: GUIDE_VERSION });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message || String(err) }, 500);
  }
});
