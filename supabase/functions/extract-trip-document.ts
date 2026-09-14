// Supabase Edge Function: extract-trip-document
// Path in Supabase: functions/extract-trip-document/index.ts
//
// PURPOSE
// Receives an uploaded PDF (trip sheet OR handling notes), sends it to
// the AI API server-side (key never exposed to the browser), gets back
// structured JSON matching Beacon's leg schema, and returns it to the
// front-end for review in the Import Trip Documents staging screen.
// Nothing is written to the real `legs` table here - that only happens
// when the user clicks Confirm in the browser, using the existing
// storage.set() save path.
//
// DOCUMENT HANDLING - read this before answering anyone about retention.
// The PDF arrives base64 in the request body, is forwarded to the AI API as
// a document block, and the reply is parsed and returned. It is never written
// to a bucket, a table, or a log by this code. It exists in this function's
// memory for the length of the request and nothing else. What the platform
// logs about a request is a Supabase setting, not something this file
// controls; what the AI provider retains is what zero-data-retention is for.
//
// ---------------------------------------------------------------------
// WHO MAY CALL THIS - added 10 Sep 2026
//
// Until this revision the function was open: no token was required, the
// URL is in the page source, and anyone could POST a document and spend the
// department's AI credit with nothing recording who. The department on/off
// switch lived only on the front-end button, which is no gate at all for a
// caller who is not using the front end.
//
// Now, three things, all required:
//
// 1. The request must carry the caller's own Supabase session token in the
//    Authorization header. The front end (build 2026-09-10T19:00:00Z and
//    later) sends it. With JWT verification ON in the dashboard, the gateway
//    refuses anything without a valid token before this code even runs.
// 2. This code checks the token again by asking Supabase who the user is.
//    Belt and braces: if verification is ever switched off by mistake, the
//    function still refuses anonymous callers on its own.
// 3. The department switch is read THROUGH THE CALLER'S TOKEN, not with the
//    service role. RLS on flight_departments only returns rows for
//    departments the caller belongs to, so a "true" here proves both that the
//    switch is on and that the caller is actually a member. If no row comes
//    back with the switch on, the document is refused before it is sent
//    anywhere. This is the same read the front end makes in loadAiExtraction.
//
//    Known looseness: a person in more than one department passes if ANY of
//    their departments has the switch on. Today nobody is in two. To tighten
//    it, have the front end send its department id in the body and check
//    that one row only - RLS still proves membership either way.
//
// SETUP (dashboard):
//  - Secrets: ANTHROPIC_API_KEY. SUPABASE_URL and SUPABASE_ANON_KEY are
//    injected automatically into every edge function; nothing to add.
//  - Edge Functions -> extract-trip-document -> Settings: "Verify JWT" ON.
//    Do this LAST, after every device has reloaded onto a build that sends
//    the token. There is no service worker; a browser on an old build sends
//    no token and is refused the moment this is switched on.
//
// ---------------------------------------------------------------------
// CHANGES IN THE TRIP BRIEF REVISION (retained)
//
// 1. "cityPair" IS GONE from the schema. It is replaced by "dep.city" and
//    "arr.city" - the same information, per end. The Trip Brief shows a
//    departure block and an arrival block side by side, and splitting a
//    single "A -> B" string is fragile when a city is "Jijoca de
//    Jericoacoara, Ceara". The front-end COMPOSES cityPair from these two
//    fields, so every existing consumer of cityPair keeps working and there
//    is only one source of truth to drift from.
//
// 2. "paxCount" ADDED - a bare integer per leg. Count only, never names.
//    See the passenger rules below.
//
// 3. DISTANCE IS DELIBERATELY NOT EXTRACTED. The Trip Brief shows distance
//    in NM, but Beacon DERIVES it from airport coordinates in its own
//    bundled database (great circle, haversine). Extracting it would mean
//    trusting whatever unit a given department's paperwork happens to print
//    - and storing statute miles in a field labelled NM is a wrong answer
//    that looks completely normal on the page. A derived figure is also
//    identical across every department regardless of their format, and
//    cannot go stale. The "total distance/NM" exclusion below therefore
//    STANDS UNCHANGED.
// ---------------------------------------------------------------------
 
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
 
// Allow the browser (Netlify-hosted app) to call this function directly.
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
 
// The exact leg field shape Beacon uses, given to the AI so it returns
// data in the right shape every time. Mirrors blankLeg() in index.html.
// Y/N fields take "Y", "N", or "" only.
const LEG_SCHEMA_DESCRIPTION = `
Return JSON with this exact shape (use empty string "" for any field you
cannot find - never omit a field, never invent data). Fields marked "Y/N"
must be exactly "Y", "N", or "" - nothing else.
 
{
  "documentType": "trip_sheet" | "handling_notes" | "unknown",
  "confidence": "high" | "medium" | "low",
  "note": "short plain-English note for the human reviewer, e.g. why confidence is low, or what could not be matched",
  "legs": [
    {
      "tripNumber": "",
      "legNumber": "",
      "date": "",
      "tailNumber": "",
      "paxCount": "",
      "crewRaw": [
        { "name": "", "roleRaw": "", "role": "" }
      ],
      "ete": "",
      "enrouteNotes": "",
      "windDirection": "",
      "windComponent": "",
      "compliance": {
        "eapisReqd": "",
        "eapisNotes": "",
        "customsReqd": "",
        "customsNotes": "",
        "overflightReqd": ""
      },
      "dep": {
        "airportId": "", "city": "", "etdLocal": "", "etdZ": "",
        "agent": "", "agentPhone": "", "frequency": "",
        "slotReqd": "", "slotTimeNumber": "", "slotAllowance": "",
        "fuelVendor": "", "fuelPricePerGallon": "", "fuelPaymentMethod": "", "rampFee": "", "rampFeeWaived": "", "rampFeeMinGallons": "",
        "groundTransportReqd": "", "groundTransportDetails": "",
        "notes": ""
      },
      "arr": {
        "airportId": "", "city": "", "date": "", "etaLocal": "", "etaZ": "",
        "agent": "", "agentPhone": "", "frequency": "",
        "slotReqd": "", "slotTimeNumber": "", "slotAllowance": "",
        "fuelVendor": "", "fuelPricePerGallon": "", "fuelPaymentMethod": "", "rampFee": "", "rampFeeWaived": "", "rampFeeMinGallons": "",
        "groundTransportReqd": "", "groundTransportDetails": "",
        "permitReqd": "", "permitNumber": "",
        "notes": ""
      }
    }
  ]
}
 
FIELD CONVENTIONS:
- "eapisReqd", "customsReqd", "overflightReqd", "slotReqd" (dep/arr),
  "groundTransportReqd" (dep/arr), "permitReqd" (arr): Y/N fields. Use "Y"
  when the document shows the item applies, is required, was filed, or was
  obtained; "N" only if the document explicitly says it is not required;
  "" if the document does not say either way.
- "dep.city" / "arr.city": the human-readable CITY name for that end of the
  leg. Take the city printed next to that airport's code, usually on the
  same line, before or after it - "WINDSOR LOCKS, CT (KBDL)" gives a city of
  "Windsor Locks". Give the CITY ONLY:
    * NO state, province or region. "WESTHAMPTON BEACH, NY" -> "Westhampton
      Beach". "FORTALEZA, CEARA" -> "Fortaleza".
    * NO country.
    * NO airport name. "WINDSOR LOCKS, CT (KBDL) - BRADLEY INTERNATIONAL"
      gives "Windsor Locks", NOT "Bradley International". The airport name
      has no field here and must not be substituted for the city.
    * NO airport code. Codes belong only in "airportId".
  Use normal capitalisation even when the document is in full caps, and keep
  accents as printed ("Sao Luis" stays "Sao Luis"). If the document gives no
  city for an end, leave it "" - do not infer one from the airport code and
  do not repeat the other end's city.
- "paxCount": the number of PASSENGERS on THIS leg, as a plain integer
  string ("0", "5", "11"). See the PASSENGERS section below - the rules
  there are strict and matter more than filling the field.
- "date" (top level): the leg's DEPARTURE date - the local calendar date at
  the DEPARTURE airport on which the flight departs. Format strictly as ISO
  YYYY-MM-DD (e.g. "2026-06-11"). Never use US MM/DD/YYYY or any other
  format for this field, whatever format the document prints it in.
- "arr.date": the leg's ARRIVAL date - the local calendar date at the
  ARRIVAL airport on which the flight lands. Same strict ISO YYYY-MM-DD
  format. This is a SEPARATE field from the top-level departure date and
  must be extracted independently - do NOT simply copy the departure date
  into it. On most legs the two dates are the same, but on overnight or
  red-eye flights, and on long flights that cross the date line or a large
  number of time zones, the arrival date is the NEXT day (or occasionally
  the PREVIOUS day, e.g. an eastbound Pacific crossing). Take the arrival
  date from what the document actually prints against the arrival/landing
  time. If the document shows an explicit arrival date, use it. If it shows
  a day-change marker against the arrival time instead (e.g. "+1", "(+1)",
  "next day", a superscript 1, or a second date printed in the arrival
  column), apply that marker to the departure date to get the arrival date.
  If the document gives no arrival date and no day-change marker, and the
  arrival is clearly the same calendar day, use the same date as departure.
  Only leave "arr.date" blank when the document genuinely does not let you
  determine it - never guess by computing flight time yourself.
- "eapisNotes", "customsNotes": always "". Never populate - the Y/N
  required flags carry all the signal this system needs.
- "permitReqd"/"permitNumber" live under "arr" only - a landing permit or
  PPR belongs to the airport being landed at. Put the PPR/permit number in
  "arr.permitNumber" (e.g. "PPR 172892").
- "tailNumber": the registration of the aircraft flying this leg, e.g.
  "N670BB". Set it on EVERY leg you emit.
  Most trip sheets state the aircraft ONCE, in a header or summary block at
  the top of the document, and never repeat it in the per-leg table. That
  header value applies to every leg of the trip - copy it onto all of them.
  A leg table with no tail column does NOT mean the tail is unknown.
  Registration is commonly printed together with the aircraft type, often in
  parentheses - "Aircraft: Global 7500 (N670BB)", "N670BB / Global 7500",
  "Aircraft: G650 N123AB". Take ONLY the registration and discard the type;
  the type has no field here. A registration is the alphanumeric identifier,
  usually carrying a country prefix (N, G-, D-, C-, VP-, HB-, 9H-, VH-).
  If no header carries it, the registration also commonly appears inside
  eAPIS or customs reference strings, flight-plan callsigns, fuel releases
  and permit numbers. Any of those is a valid source.
  Use a DIFFERENT tail on a particular leg ONLY where that leg explicitly
  names a different registration - a genuine tail swap mid-trip, which is
  rare. Absent an explicit per-leg registration, one tail covers the whole
  trip.
  Leave "tailNumber" empty only if the document names no registration
  anywhere.
 
PASSENGERS - COUNT ONLY, AND ONLY WHEN IT IS THIS LEG'S COUNT:
 
*** NEVER RETURN PASSENGER IDENTITY. *** No names, no phone numbers, no
weights, no lead-passenger flags, no per-passenger rows of any kind. There
is no field for any of it and none may be placed in any other field. The
ONLY passenger data this system takes is a count.
 
- "paxCount": the number of passengers on THIS leg, as a plain integer
  string. Not a range, not "5 pax", not a word - just the digits.
- Documents state this in different ways. Common shapes:
    * a passenger table with names down the side and a column per leg, an
      X or similar mark where that person is aboard, and a TOTALS row
      underneath giving the per-leg count. READ THE TOTALS ROW. You do not
      need to read the names above it, and you must not return them.
    * a per-leg field labelled "PAX", "POB", "Passengers" or similar.
    * a passenger count printed inside a leg's row or block.
  Match the meaning, not the layout.
- If no totals row is given but the document marks per-leg attendance, you
  may COUNT the marks in that leg's column. Count only - never transcribe
  who they are.
- *** A TRIP-LEVEL COUNT IS NOT A LEG COUNT. *** If the document gives one
  passenger figure for the whole trip, with no way to tell who is on which
  leg, leave "paxCount" EMPTY ON EVERY LEG. Do not copy the trip figure onto
  each leg. A trip very often carries different numbers on different legs -
  positioning legs frequently fly empty - so spreading one number across
  them would be wrong on most of them, and wrong invisibly.
- "0" IS A REAL ANSWER AND IS NOT THE SAME AS BLANK. A leg the document
  shows as carrying nobody is "0". A leg whose count you cannot establish is
  "". Never write "0" to mean "I could not tell".
- If a passenger's presence on a leg is ambiguous, leave the whole leg's
  count blank rather than returning a number you are unsure of. A blank is
  visible to the reviewer and gets corrected; a plausible wrong number does
  not.
 
CREW - READ THIS SECTION CAREFULLY:
The governing principle is that this system HONOURS THE DOCUMENT. It reports
crew exactly as the document states it. It does not correct, tidy, promote,
demote, or reconcile what it finds. If the document is silent or ambiguous,
the correct output is a blank field, not a plausible guess.
 
- "crewRaw": an ARRAY with ONE ENTRY PER PERSON assigned to THIS leg. Not a
  fixed set of seats. A leg may carry two SICs, two cabin attendants, an
  augmented crew of five, or nobody at all. Return as many entries as the
  document assigns, in the order printed. If the document names no crew for
  this leg, return an empty array [].
- "crewRaw[].name": the person's name EXACTLY as printed for that leg -
  same spelling, same word order, same amount of it. If the document prints
  only a surname, return only the surname. If it prints a full legal name,
  return the full legal name. Do NOT expand, abbreviate, reorder, or
  normalise capitalisation, and never merge two spellings of what you
  believe is the same person into one.
- "crewRaw[].roleRaw": the role indicator printed against that person for
  THIS leg, exactly as it appears - a matrix code ("P", "S", "A", "C"), a
  title prefix ("Capt"), a spelled-out role ("PILOT IN COMMAND", "CABIN
  ATTENDANT"), or "" if the document attaches no role to them.
- "crewRaw[].role": the normalised role, and ONLY where the document makes
  it unambiguous. Permitted values are exactly "PIC", "SIC", "ACM", "FA",
  "FE", "CKA", "MX", or "" - nothing else.
 
  Normalise these, which are the same role under different names:
    PIC  <- P, PIC, CAPT, CAPTAIN, PILOT IN COMMAND, COMMANDER
    SIC  <- S, SIC, FO, F/O, FIRST OFFICER, COPILOT, CO-PILOT, SECOND IN COMMAND
    ACM  <- A, ACM, ADDITIONAL CREW MEMBER, SAFETY PILOT
    FA   <- C, FA, F/A, CABIN ATTENDANT, CABIN CREW, FLIGHT ATTENDANT,
            CABIN SERVER, STEWARD, STEWARDESS
    FE   <- E, FE, F/E, FLIGHT ENGINEER
    CKA  <- K, CKA, CHECK AIRMAN, CHECK PILOT
    MX   <- M, MX, MAINT, MAINTENANCE, MECHANIC, ENGINEER (when clearly a
            maintenance technician rather than a flight engineer)
 
  "CABIN ATTENDANT" and "FLIGHT ATTENDANT" are the SAME role and both
  normalise to "FA". This is a naming difference only.
 
- *** DO NOT COLLAPSE DISTINCT ROLES. *** ACM and SIC overlap in practice,
  and an ACM is very often a qualified pilot, but when a document prints
  them as separate codes that separation was a deliberate act by whoever
  filled the form in. Report ACM as "ACM" and SIC as "SIC". Never merge
  them, never promote an ACM into an empty SIC seat, and never treat a
  second pilot as an SIC because the SIC seat looks unfilled.
- *** "CA" IS AMBIGUOUS AND MUST NEVER BE ASSUMED. *** Some operators use
  "CA" for CAPTAIN, others for CABIN ATTENDANT. These are entirely
  different jobs. Resolve it ONLY if the same document proves which is
  meant - for example a printed legend, or the same person appearing
  elsewhere with an unambiguous role. If it is not proven, put "CA" in
  "roleRaw" and leave "role" EMPTY. A cabin attendant recorded in the
  captain's seat is the most dangerous error this system can make.
- If a document prints a LEGEND or key for its role codes, that legend
  governs for that document and overrides the general list above.
- Leaving "role" blank is a NORMAL and CORRECT outcome, not a failure. Some
  packages list who is aboard without stating any roles at all - in that
  case return every name with "roleRaw" and "role" both empty. Do not
  assign roles by seniority, by name order, by which name appears first, or
  by guessing from a job title mentioned elsewhere in the document.
- Where a document gives a per-leg crew grid (people down one side, leg
  numbers across the top, a role code in each cell), read each leg's column
  independently. A person with no code for a given leg is NOT on that leg.
- Crew and passengers are NOT mutually exclusive. The same person can be
  crew on one leg and a passenger on another, sometimes appearing in both
  tables of the same document. Never exclude a name from "crewRaw" because
  it also appears as a passenger.
 
- "legNumber": fill ONLY when the document EXPLICITLY states a leg or
  sequence number for this flight. If none is stated, return an empty
  string "" - never invent, infer, or default to "1". A standalone
  flight brief usually has NO leg number.
- "windDirection": "HW" if the average enroute wind is a headwind, "TW" if
  a tailwind, "" if not stated.
- "windComponent": the average wind component in knots as a signed string -
  negative for a headwind (e.g. "-33"), positive for a tailwind (e.g.
  "+12"), "" if not stated.
- "ete": estimated time enroute (e.g. "7:27" or "7h27m" as printed).
- "enrouteNotes": always "". Never populate. (Routing, distance, fuel
  burn, and ETP data are deliberately excluded - see the exclusion list.)
- "fuelVendor" (dep/arr): the fuel supplier/into-plane vendor and fuel grade
  if shown (e.g. "Fuelex / Grafair-BMA, JET-A1"). Attach it to the end
  (departure or arrival) the document ties the fuel uplift to.
- "fuelPricePerGallon" (dep/arr): the QUOTED fuel price per gallon for that
  airport - the contract/quoted price the operator actually pays, NOT the
  posted retail/rack rate. If both a posted price and a quoted price are
  shown, always take the quoted one and ignore posted retail. Prefix the
  value with "Quoted " and keep the currency and units as printed, e.g.
  "Quoted $6.25/gal". Each airport has its own price - attach each quoted
  price to the specific airport it is printed against, and place it on the
  leg-end (departure or arrival) that airport occupies. Never copy one
  airport's price onto another.
- "fuelPaymentMethod" (dep/arr): how the fuel is paid for at that airport,
  as printed - e.g. "Direct bill", "AVCARD", "Credit card", "BP", "World
  Fuel", "Contract". This is distinct from the fuel vendor and will often
  differ from it - capture it separately, do not merge with fuelVendor.
- "rampFee" (dep/arr): the ramp/handling fee amount as printed, e.g.
  "$150". If the sheet explicitly states there is no fee, capture "No fee".
- "rampFeeWaived" (dep/arr): "Y" or "N" - whether the ramp fee is waived
  with a fuel purchase. ALWAYS set this to Y or N, never leave it blank.
  If the sheet shows no fee at all, set "N".
- "rampFeeMinGallons" (dep/arr): the minimum fuel uplift in gallons that
  waives the fee (often printed as "fee waived at X gallons"). Populate
  this ONLY when rampFeeWaived is "Y". When rampFeeWaived is "N", leave
  this blank - the app fills it automatically.
- WHERE THE FUEL/RAMP DATA LIVES: on many trip sheets the fuel and ramp
  figures are NOT in the main leg table. They sit in a separate
  services/confirmations table (columns like ICAO, Request Type, Vendor,
  Confirmation, Phone, Comments), often grouped under the same
  "LEG N (DEP - ARR)" headers as the leg table. You MUST read this table.
  For every row whose Request Type is "Fuel":
    * Assign the data to the leg named in that row's group header, on the
      leg-end (departure or arrival) whose airport code matches the row's
      ICAO. If the row's ICAO is not the departure or arrival of any leg in
      the main leg table, ignore that row - do NOT invent a leg for it.
    * fuelVendor: take the name in the Vendor COLUMN (e.g. "Atlantic
      Aviation"). IGNORE any "Fuel Vendor: Manual Price" line in the
      Comments - "Manual Price" is not a vendor, it only means the price
      was keyed in manually. Never merge that phrase into fuelVendor.
    * The Comments cell holds labeled lines - read them literally:
      "Payment Method: X"   -> fuelPaymentMethod = X
      "Quoted Price: $X"    -> fuelPricePerGallon = "Quoted $X"
                               (take the QUOTED line; ignore "Posted Retail:")
      "Ramp Fee: $X" or "Ramp Fee: No Fee" -> rampFee
      "Fee Waived at: X gal" -> rampFeeWaived = "Y" and
                               rampFeeMinGallons = X. If no such line is
                               present, rampFeeWaived = "N".
    * Keep each airport's own values - never copy one airport's fuel or
      ramp figures onto another.
- "slotReqd"/"slotTimeNumber"/"slotAllowance" and "groundTransport*"
  (dep/arr): attach each to whichever end the document associates it with.
`;
 
const EXTRACTION_PROMPT = `
You are extracting structured data from an aviation trip document for a
flight department's trip-planning system. The document could be one of
two very different things, and you must first identify which:
 
Spend your attention efficiently. These documents run many pages, but most
of that bulk is tactical flight-operations material you must IGNORE - flight
routing, waypoints, NOTAMs, weather, procedures, altitudes, and fuel-burn
figures. Do not reason about or dwell on that content. Skim past it. BUT DO
NOT let this skimming cause you to miss the COMMERCIAL fuel and handling
data - the fuel VENDOR, the fuel PRICE per gallon, the PAYMENT METHOD, and
RAMP/handling FEES. This data is high-value and usually does NOT live in
the main leg table; it sits in a separate services/confirmations table
(often toward the end of the document) that you must read in full. Actively
hunt for it - it is exactly what this system captures. Focus your effort
on the handling and logistics data this system captures:
airports, cities, dates, local and Zulu times, passenger counts, ground
agents and phone numbers, frequencies, slots, fuel vendor, ground transport,
compliance required flags, and any stated permit/PPR number.
 
The ONLY thing that matters for this classification is COMPLETENESS - does
this document describe the WHOLE TRIP, or just ONE LEG of it? Do NOT rely on
the document's title, its header, its layout, or which company or system
produced it. Different flight departments format these documents completely
differently; judge only by what the document is actually ABOUT.
 
1. A WHOLE-TRIP document ("trip_sheet") - presents the trip as a complete
   set: it lays out the trip's legs as a sequence and reads as the
   authoritative, current record of the entire trip (a trip sheet, a trip
   itinerary, or any equivalent). A document that lists multiple legs as a
   set is almost always this. IMPORTANTLY, a genuine single-leg trip counts
   here too: if a document presents itself as the complete record of a trip
   that simply happens to have only one leg, it is a WHOLE-TRIP document.
 
2. A SINGLE-LEG document ("handling_notes") - a detailed brief about ONE
   leg or ONE airport/date (weather, ground handling, permits, slots, fuel,
   FBO/agent contact, parking, customs). It reads as a slice or deep-dive of
   a larger trip, NOT as the trip's complete record. It exists to enrich a
   leg that should already exist, not to define the whole trip.
 
Decision rule and safe default: judge by how the document PRESENTS ITSELF -
as the complete trip record versus a detailed brief on one flight - not
merely by the leg count. A one-leg document is ambiguous on its own. When
you genuinely cannot tell whether a one-leg document is a complete one-leg
trip or a single-leg brief of a larger trip, DEFAULT to "handling_notes"
(single-leg). This is the safe choice: treating an authoritative document as
partial merely leaves a stale leg for the user to remove by hand, whereas
treating a partial brief as authoritative could silently delete real legs.
Only classify a one-leg document as "trip_sheet" when it clearly presents
itself as the complete record of the trip.
 
Set "documentType" accordingly. If you cannot tell it is a trip document at
all, set it to "unknown" and explain briefly in "note" - do not guess.
 
FORMAT-AGNOSTIC BY DESIGN: this system serves many flight departments, each
with its own paperwork. Find every value by WHAT IT MEANS, never by where it
sits on a page or what a particular form calls it. Any example given below
is one illustration, not the expected layout.
 
WHEN IN DOUBT, LEAVE IT BLANK. Across every field in this schema, a value
you cannot establish from the document must be returned empty. Never infer,
never spread one value across items it was not stated for, never default.
A blank field is visible to the human reviewer and gets corrected. A
plausible wrong value looks exactly like a right one and does not.
 
For every leg you can identify, extract:
- departure and arrival airport codes
- the departure and arrival CITY names, separately, in "dep.city" and
  "arr.city". City only - no state, no country, no airport name, no code.
  See the FIELD CONVENTIONS entry for exactly what to include.
- the date of departure, as ISO YYYY-MM-DD, in the top-level "date" field
- the date of ARRIVAL, as ISO YYYY-MM-DD, in "arr.date". This is a separate
  field and must be read from the document rather than assumed to match the
  departure date - overnight and red-eye legs land on the following day, and
  getting this wrong is worse than leaving it blank. See the "arr.date"
  entry in FIELD CONVENTIONS for exactly how to determine it.
- local AND Zulu departure/arrival times, if both are present
- the PASSENGER COUNT for that leg, in "paxCount" - a bare number, never
  any passenger's identity. Read the PASSENGERS section of the schema
  before filling this: a trip-wide figure is NOT a per-leg count, and "0"
  means the leg genuinely carries nobody rather than "unknown".
- the ground handling agent or FBO name and phone number, for departure
  and arrival separately
- radio frequency information, if present
- estimated time enroute ("ete"), and the average enroute wind as
  "windDirection" ("HW"/"TW") plus a signed "windComponent" in knots
- EAPIS required status, customs landing-rights required status, and
  overflight-permit required status, in the "compliance" object (the Y/N
  required flags only - see the exclusion list below for the notes fields)
- a landing permit or PPR for the ARRIVAL airport, in
  "arr.permitReqd"/"arr.permitNumber"
- slot requirements (required flag, slot time/number, allowance) for each
  end, in dep/arr
- fuel vendor + grade for each end, in dep/arr "fuelVendor"
- quoted fuel price per gallon for each end, in dep/arr "fuelPricePerGallon"
- fuel payment method for each end, in dep/arr "fuelPaymentMethod"
- ramp fee, ramp-fee-waived flag, and minimum gallons to waive for each
  end, in dep/arr "rampFee" / "rampFeeWaived" / "rampFeeMinGallons"
- ground transportation (required flag + details) for each end, in dep/arr
 
Follow the FIELD CONVENTIONS in the schema below exactly, especially the
Y/N values, the signed wind component, the separate departure and arrival
dates, the city rules, the passenger-count rules, and putting the landing
permit/PPR under "arr".
 
Do NOT extract or return passenger names, passenger phone numbers, passenger
weights, or any other passenger personal information, even if present in the
document - skip those entirely. The ONLY passenger data this system takes is
the per-leg COUNT, in "paxCount".
 
Do NOT extract or return any TACTICAL FLIGHT-OPERATIONS data. This system
captures the handling/logistics layer only (who, where, when), never the
fly-it layer, because that data changes and pilots get it from authoritative
live sources - a stale copy in this app is worse than none. Specifically,
leave these OUT entirely and never place them in any field:
- flight routing of any kind: airways, waypoints, fixes, route strings,
  total distance/NM. (Beacon derives great circle distance from airport
  coordinates itself - a printed distance is neither needed nor wanted, and
  its units vary by document.)
- departure/arrival procedures: SIDs, STARs, approaches, runway
  assignments
- NOTAMs and runway/taxiway closures or restrictions
- altitudes, flight levels, ETP/ETOPS/diversion details
- fuel QUANTITIES: block fuel, fuel burn, uplift amounts, tankering figures
  (this exclusion is ONLY about weights/volumes. You MUST still capture the
  commercial fuel handling details wherever they appear: fuel VENDOR and
  grade, fuel PRICE per gallon, PAYMENT METHOD, and ramp fees. Exclude only
  the number of pounds or gallons, never the pricing.)
If a notes field would otherwise contain any of the above, leave it blank.
 
*** PERSONAL AND IDENTITY DATA - ABSOLUTE PROHIBITION ***
Trip packages frequently include customs and immigration paperwork
(General Declarations, CBP Form 6059B, APIS submissions, passport scans)
that carries sensitive personal data about crew and passengers. This system
captures CREW NAMES ONLY, plus a passenger COUNT. You MUST NOT extract,
transcribe, summarise, quote, paraphrase, or place in ANY field - including
notes fields - any of the following, for crew or passengers:
- passenger names of any kind
- passport, visa, or identity document numbers
- passport or visa issue dates, expiry dates, or place of issue
- dates of birth or ages
- home, residential, or personal mailing addresses
- nationality, citizenship, or country of residence
- personal government identifiers of any kind
This prohibition is not a preference and has no exceptions. It applies even
when the data sits directly beside something you are asked to capture, even
when a field seems to invite it, and even when it would raise your
confidence. If a crew name is the only thing you can safely take from a
customs form, take only the name. If capturing a field would require
reproducing any of the above, leave that field blank instead.
 
*** CONFLICTING OR SUPERSEDED LEGS - DETECT, DO NOT RESOLVE ***
A single package can describe flights that contradict each other, because
plans change mid-trip and providers often leave the superseded paperwork in
the package. A real example: a transmittal sheet and flight log described
LSZH-KTEB on one date, while the fuel authorisation and both General
Declarations in the SAME package described ESSB-KTEB on the next day. The
trip had genuinely changed after the fuel arrangements were made, and the
dead paperwork was never removed.
You CANNOT resolve this, because the answer is not in the document. Nothing
states which version is live, and the superseded pages look exactly as
authoritative as the current ones. Choosing between them risks selecting the
cancelled flight.
Therefore:
- Emit the legs from the section that most clearly represents the operating
  flight - normally the primary leg table, flight log, or itinerary.
- Do NOT silently drop, merge, average, or reconcile the conflicting version.
- Do NOT emit both as if they were separate sequential legs of one trip.
- SET "confidence" TO "low" and STATE THE CONFLICT PLAINLY in "note",
  naming both routings and both dates so a human can decide - e.g.
  "This package contains conflicting legs - ESSB-KTEB on 2026-06-12
  (fuel authorisation, General Declarations) and LSZH-KTEB on 2026-06-11
  (transmittal, flight log). Please confirm which is live."
The same applies to any internal disagreement about crew, tail, dates,
times or passenger numbers: report what the primary source says, and flag
the disagreement in "note" rather than picking a winner quietly.
 
 
IMPORTANT - avoid duplicate legs: some trip sheets contain ONE primary leg
table near the top (usually with departure/arrival times and an ETE/distance
column) that is the authoritative source of legs, followed LATER in the same
document by a separate "handling worksheet" or checklist section. That later
section often repeats airport codes under headings like "LEG 2 (KFOK - SBFZ)"
alongside blank template fields (e.g. "HANDLING-", "OPS HRS-", "PARKING-",
"PERMIT(S)-"), sometimes listing the SAME airport twice (once as a row for
the departure end, once for the arrival end) for handling/logistics purposes.
This later section is NOT a new set of legs - it is supplementary detail
about legs that already exist in the primary leg table, or in some cases is
just an unfilled template with no real data. Only emit one leg entry per
distinct leg in the primary leg table. Do not create additional leg entries
from a handling worksheet, checklist, or any section whose rows list just an
airport code plus generic handling/permit/customs placeholders with no
actual flight date or departure/arrival time. When in doubt about whether a
section is a real leg or a handling worksheet entry, prefer NOT creating a
duplicate leg.
 
Match field meaning, not page position or layout - different providers
format documents very differently, as tables, paragraphs, or forms, with
different labels. Focus on what the field
represents (e.g. "departure time zulu", "arrival ground handler phone"),
not where it sits on the page.
 
OUTPUT DISCIPLINE - keep the response small. This document may run
dozens of pages, but the trip it describes is almost always ONE flight
leg (occasionally a short clean multi-leg table). Do NOT let page count
drive leg count:
- Emit exactly ONE leg unless the primary leg table clearly lists
  several distinct dated legs. Alternates, ETP/ETOPS diversion airports,
  fuel-stop candidates, and weather-alternate airports are NOT legs -
  never emit a leg for them.
- The free-text notes fields "enrouteNotes", "eapisNotes",
  "customsNotes", "dep.notes", and "arr.notes" must ALWAYS be returned
  as an empty string "". Do not summarise, transcribe, or place any text
  in them - they are intentionally unused. The only free-text field you
  may fill is "note" (the reviewer note), kept to one brief sentence.
- "arr.permitNumber": fill ONLY when a specific landing-permit or PPR
  number is stated (e.g. "PPR 172892"); otherwise leave it "".
- Never repeat the same information across multiple fields.
 
Return ONLY the JSON object described below. No prose, no explanation,
no markdown code fences - just the raw JSON.
 
${LEG_SCHEMA_DESCRIPTION}
`;
 
serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
 
  try {
    // ---- 1. Who is calling? -------------------------------------------
    // Refuse anything without a bearer token before reading the body, so an
    // anonymous caller never gets as far as uploading a document.
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) {
      return jsonResponse({ error: "Not signed in. Sign in again and retry the upload." }, 401);
    }
 
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY are not available to the function");
    }
 
    // A client that acts AS THE CALLER. Every read below goes through RLS
    // exactly as it would from the browser - no service role anywhere here.
    const sb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
 
    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Your session has expired. Sign in again and retry the upload." }, 401);
    }
 
    // ---- 2. Is extraction switched on for the caller's department? -----
    // Same read the front end makes in loadAiExtraction. RLS returns only the
    // departments this person is in, so a row with the switch on proves
    // membership AND permission in one query. "Unknown" is "no", same as the
    // front end: when the answer is not known, the document does not leave.
    const { data: depts, error: deptErr } = await sb
      .from("flight_departments")
      .select("id, ai_extraction_enabled");
    if (deptErr) {
      throw new Error(`Could not read department settings: ${deptErr.message}`);
    }
    const enabled = Array.isArray(depts) && depts.some((d) => d.ai_extraction_enabled === true);
    if (!enabled) {
      return jsonResponse(
        { error: "AI extraction is switched off for your flight department. An admin can turn it on in Settings." },
        403,
      );
    }
 
    // ---- 3. Only now touch the AI key and the document. -----------------
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set in Edge Function secrets");
    }
 
    // Expect the browser to send the PDF as base64 in JSON:
    // { "fileName": "...", "fileBase64": "..." }
    const body = await req.json();
    const { fileBase64 } = body;
 
    if (!fileBase64) {
      return jsonResponse({ error: "No file data received" }, 400);
    }
 
    // Call the Anthropic API server-side. The PDF is sent as a document
    // content block; Claude reads PDFs natively.
    const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: fileBase64,
                },
              },
              {
                type: "text",
                text: EXTRACTION_PROMPT,
              },
            ],
          },
        ],
      }),
    });
 
    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      throw new Error(`AI API error: ${aiResponse.status} ${errText}`);
    }
 
    const aiData = await aiResponse.json();
    const rawText = aiData?.content?.map((b) => b.text || "").join("") || "";
 
    // The model is instructed to return raw JSON only, but strip any
    // accidental code-fence wrapping just in case.
    const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
 
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_parseErr) {
      // If the model ran out of output room, its JSON is cut off mid-stream.
      // Give a plain-English reason instead of a cryptic parse error.
      // The raw model output is NOT returned: on a bad day it is a partial
      // trip sheet, and it has no business going back to a browser that
      // could log it. stopReason and the block types are enough to diagnose.
      const truncated = aiData?.stop_reason === "max_tokens";
      const message = truncated
        ? "This trip is too large to process in one pass \u2014 the AI response was cut off before it finished. Try splitting the document into fewer legs, or contact support to raise the limit."
        : "AI response could not be parsed as JSON";
      return jsonResponse(
        {
          error: message,
          truncated: truncated,
          stopReason: aiData?.stop_reason || null,
          contentBlockTypes: (aiData?.content || []).map((b) => b.type),
        },
        502,
      );
    }
 
    return jsonResponse(parsed);
  } catch (err) {
    return jsonResponse({ error: err.message || String(err) }, 500);
  }
});
