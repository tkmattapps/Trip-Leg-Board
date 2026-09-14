// Supabase Edge Function: manage-department-user
// Path in Supabase: functions/manage-department-user/index.ts
//
// PURPOSE
// The one path in Beacon that can create a user account, plus the reset that
// makes a lost password a thirty-second fix instead of an incident -- and,
// since 14 Sep 2026, the one path that can change a sign-in address.
//
// WHY THIS HAS TO BE A SERVER FUNCTION
// Creating an Auth account needs the SERVICE ROLE KEY. That key bypasses RLS
// completely - every rule protecting every table is off for anything holding
// it. It can therefore NEVER be in index.html, and the work has to happen
// here, behind a check we control.
//
// *** THE ADMIN CHECK BELOW IS NOT A FORMALITY. ***
// Inside this function there is no RLS. The verifyCallerIsAdmin() step is the
// ONLY thing standing between any authenticated user and the ability to mint
// accounts in someone else's flight department. Two consequences, both
// deliberate:
//   1. The caller's identity comes from their JWT and NOTHING ELSE. The
//      request body never says who the caller is. A body can claim anything.
//   2. The check runs as the CALLER, not as service role, by calling the same
//      is_department_admin() helper the UPDATE policy uses. One definition of
//      "admin", so the two cannot drift apart later.
//
// SETUP
// 1. Edge Functions -> Create a new function -> name it exactly
//    "manage-department-user"
// 2. Paste this entire file in as index.ts
// 3. No secrets to add. SUPABASE_URL, SUPABASE_ANON_KEY and
//    SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// 4. Deploy. URL will be:
//    https://wfmvvvhjcxiubstzzqrb.supabase.co/functions/v1/manage-department-user
//
// NOTE: this is a NEW function. Unlike extract-trip-document, which must
// always be updated in place, this one genuinely is "Deploy a new function".

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Password generation
//
// Generated rather than admin-chosen. An admin typing passwords for four
// pilots in one sitting produces four variations on one theme; a generator
// does not. It also makes plain to the recipient that the password is
// temporary and not something their colleague picked for them.
//
// The alphabet excludes 0/O and 1/l/I. This password gets read aloud or
// written on paper, so characters that look alike are a real cost.
//
// Shown ONCE, then unrecoverable - Supabase stores only a hash, so not even
// the service role key can read it back. That is the property we want. The
// answer to a lost password is RESET, never a list of passwords kept
// somewhere by an admin.
// ---------------------------------------------------------------------------
const PW_ALPHABET = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";

function generatePassword(): string {
  const groups: string[] = [];
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  let i = 0;
  for (let g = 0; g < 3; g++) {
    let chunk = "";
    for (let c = 0; c < 4; c++) {
      chunk += PW_ALPHABET[bytes[i++] % PW_ALPHABET.length];
    }
    groups.push(chunk);
  }
  // Hyphenated so it can be transcribed and read back without losing place.
  return groups.join("-");
}

// ---------------------------------------------------------------------------
// Validation. Mirrors the database constraints exactly.
//
// Everything checkable is checked BEFORE the Auth account is created. That is
// the whole strategy for the split-transaction problem below: the realistic
// failures - duplicate abbreviation, bad job title, malformed email - are all
// knowable in advance, so the window in which a half-created user can exist
// shrinks to almost nothing. The cleanup path still exists for the rest.
// ---------------------------------------------------------------------------
const JOB_TITLES = ["pilot", "dispatcher", "flight attendant", "maintenance"];

function normalizeAbbrev(s: unknown): string {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function cleanStr(s: unknown, max = 120): string {
  return String(s || "").trim().slice(0, max);
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ error: "Function is not configured." }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request body." }, 400);
  }

  const action = String(body.action || "");
  const deptId = cleanStr(body.flight_department_id, 64);
  if (!deptId) return json({ error: "Missing flight department." }, 400);

  // -------------------------------------------------------------------------
  // STEP 1 - who is calling?
  //
  // Note verify_jwt is on by default for edge functions, but that only proves
  // the token is well-formed and signed - the ANON KEY itself satisfies it.
  // It does not prove a signed-in human. getUser() is what does that.
  // -------------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "Not signed in." }, 401);
  }

  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !userData?.user?.id) {
    return json({ error: "Not signed in." }, 401);
  }
  const callerId = userData.user.id;

  // -------------------------------------------------------------------------
  // STEP 2 - is the caller an admin OF THIS DEPARTMENT?
  //
  // Called on the CALLER's client, so auth.uid() inside the helper resolves to
  // them. Run as service role it would evaluate with a null uid and fail
  // closed - correct, but useless.
  //
  // The body supplies which department, and that is fine: we are not trusting
  // it, we are verifying it. Claiming a department you do not administer just
  // fails here.
  // -------------------------------------------------------------------------
  const { data: isAdmin, error: adminErr } = await asCaller.rpc("is_department_admin", {
    dept_id: deptId,
  });
  if (adminErr) {
    return json({ error: "Could not verify permission.", detail: adminErr.message }, 500);
  }
  if (isAdmin !== true) {
    return json({ error: "You are not an admin of this flight department." }, 403);
  }

  // From here on: service role. RLS is off. Every query must scope itself
  // explicitly, because nothing else will.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // ==========================================================================
  // ACTIVE MEMBERSHIP -- the single definition, used by every check below.
  //
  // Removal no longer deletes a membership row; it END-DATES it. That means a
  // row existing is no longer proof that someone is in the department, and
  // every check that used to rely on "a row came back" has to ask about dates
  // instead. Missing one of them fails OPEN, which is the dangerous direction:
  //  * reset_password would let an admin reset a DEPARTED person's password
  //  * guardRemoval would count DEPARTED admins toward "there is more than one"
  //    and so allow the last ACTIVE admin to be end-dated
  //
  // The predicate is copied verbatim from get_my_flight_department_ids() and
  // is_department_admin() (migration 9) so all four agree:
  //     starts_on <= current_date AND (ends_on IS NULL OR ends_on > current_date)
  //
  // *** ends_on IS A DATE, NOT A TIMESTAMP. Setting TODAY revokes IMMEDIATELY,
  // because the comparison is strictly greater-than. Tomorrow = last full day.
  // Chosen deliberately: access should end at the moment of the conversation. ***
  //
  // current_date on Supabase is UTC, so the string below must be UTC too.
  // Building it from local time would put a department a few hours either side
  // of midnight on the wrong day.
  // ==========================================================================
  function todayUTC(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // PostgREST ANDs .or() against the other filters, so this reproduces the
  // helper's predicate exactly rather than widening it.
  function onlyActive(q: any) {
    const today = todayUTC();
    return q.lte("starts_on", today).or(`ends_on.is.null,ends_on.gt.${today}`);
  }

  // ==========================================================================
  // ACTION: reset_password
  // ==========================================================================
  if (action === "reset_password") {
    const targetId = cleanStr(body.user_id, 64);
    if (!targetId) return json({ error: "Missing user." }, 400);

    // *** Scope check. Being an admin of YOUR department must not confer the
    // ability to reset a password anywhere in the database. Without this, the
    // service role key would happily do it. ***
    const { data: mem, error: memErr } = await onlyActive(
      admin
        .from("memberships")
        .select("user_id")
        .eq("user_id", targetId)
        .eq("flight_department_id", deptId)
    ).limit(1);
    if (memErr) return json({ error: "Could not verify membership." }, 500);
    if (!mem || !mem.length) {
      return json({ error: "That person is not in this flight department." }, 403);
    }

    const password = generatePassword();
    const { error: pwErr } = await admin.auth.admin.updateUserById(targetId, { password });
    if (pwErr) {
      return json({ error: "Could not reset password.", detail: pwErr.message }, 500);
    }
    return json({ ok: true, password });
  }

  // ==========================================================================
  // GUARD for removal from the department.
  //
  // Two rules, and both are enforced HERE rather than in the browser, because a
  // rule attached to a control is not a rule.
  //
  //  1. The target must be in THIS department. Same reasoning as the scope
  //     check on reset_password: admin of your department must never mean
  //     reach into someone else's.
  //  2. The LAST ADMIN of a department cannot be removed. Blocking only self
  //     would leave a gap: two admins could remove each other. A department
  //     with no admin cannot create an account or promote anyone, so it is
  //     unrecoverable from inside the app.
  //
  // *** DELETING AN ACCOUNT IS DELIBERATELY IMPOSSIBLE HERE, AT ANY TIER. ***
  // The department controls MEMBERSHIP; the person controls their ACCOUNT. They
  // may well be paying for it themselves, so an admin must never be able to
  // destroy a login. Self-deletion belongs on the user's own account screen.
  // ==========================================================================
  async function guardRemoval(targetId: string): Promise<Response | null> {
    if (!targetId) return json({ error: "Missing user." }, 400);

    // ACTIVE only. An already-departed person is not "in this department", so
    // end-dating them a second time is refused rather than silently re-stamped.
    const { data: mem, error: memErr } = await onlyActive(
      admin
        .from("memberships")
        .select("user_id, is_admin")
        .eq("user_id", targetId)
        .eq("flight_department_id", deptId)
    ).limit(1);
    if (memErr) return json({ error: "Could not verify membership." }, 500);
    if (!mem || !mem.length) {
      return json({ error: "That person is not in this flight department." }, 403);
    }

    if (mem[0].is_admin === true) {
      // *** ACTIVE only, and this is the load-bearing one. Counting departed
      // admins here would let the LAST REMAINING ADMIN be end-dated, leaving a
      // department that cannot create an account or promote anyone -- and there
      // is no in-app recovery path from that. ***
      const { count, error: cntErr } = await onlyActive(
        admin
          .from("memberships")
          .select("user_id", { count: "exact", head: true })
          .eq("flight_department_id", deptId)
          .eq("is_admin", true)
      );
      if (cntErr) return json({ error: "Could not verify admins." }, 500);
      if ((count || 0) <= 1) {
        return json({
          error: "This is the only admin of this flight department. Make someone else an admin first.",
        }, 409);
      }
    }
    return null;
  }

  // ==========================================================================
  // ACTION: remove_from_department
  //
  // END-DATES the membership. It does NOT delete it.
  //
  // *** THE RECORD MUST NOT DEPEND ON THE ACCOUNT SURVIVING -- and it must not
  // depend on the MEMBERSHIP surviving either. *** Deleting the row erased the
  // fact that this person was ever here, which the archive needs: a leg flown
  // in March was flown by a member of this department, and that has to stay
  // true after they leave. End-dating keeps the history and revokes the access.
  //
  // Both scope helpers already honour the dates, so nothing else has to change
  // for access to stop:
  //     starts_on <= current_date AND (ends_on IS NULL OR ends_on > current_date)
  // Setting TODAY revokes IMMEDIATELY (strictly greater-than). See todayUTC().
  //
  // The Auth account and the public.users row survive, as before. The person
  // keeps a login they own -- consistent with the portable-account model, and
  // with the account belonging to the pilot rather than the department.
  //
  // Consequence worth knowing, UNCHANGED by this: get_my_flight_department_ids()
  // fails closed, so they sign in to an empty app. No screen anywhere lists
  // accounts with no department, and there is no self-service way back in yet.
  // ==========================================================================
  if (action === "remove_from_department") {
    const targetId = cleanStr(body.user_id, 64);
    const blocked = await guardRemoval(targetId);
    if (blocked) return blocked;

    const endsOn = todayUTC();

    // .select("id") is LOAD-BEARING: an UPDATE that matches nothing returns
    // success with an empty array, so without it a no-op would report as done.
    // The filters are re-stated rather than trusted from guardRemoval, because
    // a guard that runs earlier is not the same as a guard on the write.
    const { data: updated, error: updErr } = await onlyActive(
      admin
        .from("memberships")
        .update({ ends_on: endsOn })
        .eq("user_id", targetId)
        .eq("flight_department_id", deptId)
    ).select("id");

    if (updErr) {
      return json({ error: "Could not remove from department.", detail: updErr.message }, 500);
    }
    if (!updated || !updated.length) {
      return json({ error: "That person is not in this flight department." }, 403);
    }
    return json({ ok: true, removed: "membership", ends_on: endsOn });
  }

  // ==========================================================================
  // ADMIN ACCESS: grant_admin / revoke_admin
  //
  // *** THE WORDS ARE "GIVE" AND "REMOVE", NOT "PROMOTE" AND "DEMOTE". ***
  // Two things live next to each other here and must never be conflated:
  //   users.role          - a job title. Descriptive. Grants NOTHING.
  //   memberships.is_admin - authority.
  // In a flight department "demoted" reads as RANK, and rank is the job title.
  // A demoted pilot is a very different and much more alarming sentence than
  // one who no longer administers the software. The action names, the audit
  // labels and the UI copy all say ADMIN ACCESS for that reason.
  //
  // WHY THIS IS HERE AND NOT AN RLS POLICY: exactly the reason already written
  // above set_pto_allowance. `memberships` has two policies, both SELECT, so
  // nothing can write a membership row from the browser. That is the thing
  // keeping is_admin safe. Opening an admin-gated UPDATE policy would be a far
  // wider door than this feature needs -- and the column it would expose is
  // this one.
  //
  // WHAT is_department_admin() ACTUALLY TESTS -- four conditions, not one:
  //     is_admin = true
  //     AND membership_role = 'member'
  //     AND starts_on <= current_date
  //     AND (ends_on IS NULL OR ends_on > current_date)
  // Two consequences drive the checks below. A CONTRACTOR can never be an
  // admin, so writing true on a contractor row stores authority that does not
  // exist - worse than false, because the roster would badge them Admin while
  // every permission check refuses them. And requiring an ACTIVE membership
  // means a granted admin is effective immediately rather than silently
  // waiting on a date window.
  // ==========================================================================
  if (action === "grant_admin" || action === "revoke_admin") {
    const targetId = cleanStr(body.user_id, 64);
    if (!targetId) return json({ error: "Missing user." }, 400);

    const granting = action === "grant_admin";

    // ---- Rule: nobody removes their own admin access (Kyle, 27 Aug 2026) ---
    // Not offered in the UI either, but a rule attached to a control is not a
    // rule. Someone stepping back asks a colleague - a thirty-second
    // conversation that also leaves a record. This closes the likeliest route
    // to a stranded department: the last admin tidying up their own
    // permissions.
    if (!granting && targetId === callerId) {
      return json({
        error: "You cannot remove your own admin access. Another admin can do this for you.",
      }, 409);
    }

    // ---- Scope + eligibility ---------------------------------------------
    // ACTIVE only, same as everywhere else in this file.
    const { data: mem, error: memErr } = await onlyActive(
      admin
        .from("memberships")
        .select("user_id, is_admin, membership_role, starts_on, ends_on")
        .eq("user_id", targetId)
        .eq("flight_department_id", deptId)
    ).limit(1);
    if (memErr) return json({ error: "Could not verify membership." }, 500);
    if (!mem || !mem.length) {
      return json({ error: "That person is not in this flight department." }, 403);
    }
    const row = mem[0];

    // *** Contractors are refused EXPLICITLY, with a message saying so. ***
    // A generic failure here would look like a bug and produce a support
    // question. The refusal is the honest answer: the permission genuinely
    // cannot apply to this membership.
    if (row.membership_role !== "member") {
      return json({
        error: "Admin access is for department members. This person is a contractor.",
      }, 409);
    }

    // ---- Already in the requested state -----------------------------------
    // Reported plainly rather than written again. A no-op write would produce
    // an audit row recording a change that did not happen, which is worse than
    // no row at all: it makes the trail describe something untrue.
    if (row.is_admin === granting) {
      return json({
        ok: true,
        unchanged: true,
        is_admin: granting,
        effective: granting,
      });
    }

    // ---- Invariant: never leave a department with no admin ----------------
    // With self-removal refused above, revocation can no longer reach zero on
    // its own: if A removes B's access, A is still an admin. This check is
    // therefore NOT load-bearing today, and it is here anyway. The UI rule is
    // policy; this is an invariant enforced where the count can actually be
    // taken. Policy changes - a future bulk action, a direct call with a valid
    // token, someone later deciding self-removal is fine. A redundant guard
    // costs one query. A department with no admin costs a support incident and
    // a hand-run SQL statement against a customer's database.
    if (!granting) {
      const { count, error: cntErr } = await onlyActive(
        admin
          .from("memberships")
          .select("user_id", { count: "exact", head: true })
          .eq("flight_department_id", deptId)
          .eq("is_admin", true)
      );
      if (cntErr) return json({ error: "Could not verify admins." }, 500);
      if ((count || 0) <= 1) {
        return json({
          error: "This is the only admin of this flight department. Give someone else admin access first.",
        }, 409);
      }
    }

    // ---- Names for the audit row ------------------------------------------
    // Fetched BEFORE the write, because the row has to describe the change
    // whether or not these people are still here to be looked up later.
    // Denormalised on purpose: an audit line reading "unknown user was given
    // admin by unknown user" is not a record of anything.
    let subjectName = "";
    let actorName = "";
    let actorRole = "";
    {
      const { data: people } = await admin
        .from("users")
        .select("id, display_name, email, role")
        .in("id", [targetId, callerId]);
      (people || []).forEach((u: any) => {
        const nm = String(u.display_name || u.email || "");
        if (u.id === targetId) subjectName = nm;
        if (u.id === callerId) { actorName = nm; actorRole = String(u.role || ""); }
      });
    }

    // ---- The write --------------------------------------------------------
    // .select("id") is LOAD-BEARING: an UPDATE matching nothing returns success
    // with an empty array. Filters re-stated rather than trusted from the check
    // above, because a guard that ran earlier is not a guard on the write.
    // membership_role is re-asserted here too, so a row that changed underneath
    // us cannot be written as an admin contractor.
    const { data: updated, error: updErr } = await onlyActive(
      admin
        .from("memberships")
        .update({ is_admin: granting })
        .eq("user_id", targetId)
        .eq("flight_department_id", deptId)
        .eq("membership_role", "member")
    ).select("id");

    if (updErr) {
      return json({ error: "Could not change admin access.", detail: updErr.message }, 500);
    }
    if (!updated || !updated.length) {
      return json({ error: "That person is not in this flight department." }, 403);
    }

    // ---- The audit row ----------------------------------------------------
    // *** AN UNLOGGED CHANGE OF AUTHORITY MUST NOT STAND. ***
    // These are two systems' worth of apart - PostgREST gives no transaction
    // spanning both statements - so if the record fails, the change is PUT
    // BACK and the whole thing reported as failed. An audit that is
    // best-effort is worthless precisely when it matters, and the alternative
    // (a silent grant with no trail) is the exact state this table exists to
    // make impossible.
    //
    // The revert is a single narrow update and is the only rollback needed:
    // nothing else has been written at this point.
    //
    // NOTE the insert is the ONLY operation this function ever performs against
    // membership_changes. No update, no delete, ever - the table has no RLS
    // policy for either, and the service role must not be the thing that
    // quietly makes an append-only table not append-only.
    const { error: auditErr } = await admin.from("membership_changes").insert({
      flight_department_id: deptId,
      subject_user_id: targetId,
      subject_name: subjectName,
      field_path: "is_admin",
      field_label: "Admin access",
      old_value: granting ? "false" : "true",
      new_value: granting ? "true" : "false",
      changed_by: callerId,
      changed_by_name: actorName,
      changed_by_role: actorRole,
    });

    if (auditErr) {
      await onlyActive(
        admin
          .from("memberships")
          .update({ is_admin: !granting })
          .eq("user_id", targetId)
          .eq("flight_department_id", deptId)
      ).select("id");
      return json({
        error: "Could not record the change, so it was not made. Please try again.",
        detail: auditErr.message,
      }, 500);
    }

    // effective === is_admin here by construction: the membership was required
    // to be ACTIVE and a 'member' before we got this far, which is the other
    // three conditions of is_department_admin(). Returned explicitly anyway, so
    // the client never has to re-derive the rule and get it slightly wrong.
    return json({
      ok: true,
      is_admin: granting,
      effective: granting,
      subject_name: subjectName,
    });
  }

  // ==========================================================================
  // ACTION: set_pto_allowance
  //
  // Sets `memberships.annual_pto_days` -- the ONE stored number behind the
  // vacation tracker (migration 19).
  //
  // *** WHY THIS IS HERE AND NOT AN RLS POLICY. ***
  //   `memberships` has exactly TWO policies, both SELECT. With RLS on, NOTHING
  //   can write a membership row from the browser, and that is deliberate --
  //   it fails closed. Adding an admin-gated UPDATE policy to carry one integer
  //   would open the table to client writes for the first time, and a policy
  //   cannot easily restrict WHICH columns: the same policy that lets an admin
  //   set an allowance would let them set `is_admin`. That is a far wider door
  //   than this feature needs. Routing through the service role keeps it shut.
  //
  // *** THE TRACKER IS A REFERENCE, NOT A RULE (Kyle, 24 Aug 2026). ***
  //   Nothing here validates the number against accrual policy, years of
  //   service, or days already taken. The workbook's tier table is REFERENCE
  //   CONTENT, displayed but never executed. A negative remaining balance is a
  //   FACT WORTH SEEING, not an error to prevent -- three of them exist on the
  //   real sheet today. So: no upper bound, and no refusal.
  //
  // The USED figure is never written anywhere. It is DERIVED from
  // crew_exceptions via crew_ledger() (migration 18). That is the whole point:
  // the spreadsheet's used figure drifted precisely because it was maintained
  // separately from the calendar it should have agreed with.
  // ==========================================================================
  if (action === "set_pto_allowance") {
    const targetId = cleanStr(body.user_id, 64);
    if (!targetId) return json({ error: "Missing user." }, 400);

    // ---- the value -------------------------------------------------------
    // null / "" CLEARS the allowance. Null means "not yet set", which is a
    // genuinely different state from zero and must stay reachable: an admin
    // who typed a number into the wrong row needs a way back to blank.
    const raw = body.annual_pto_days;
    let days: number | null = null;

    if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return json({ error: "PTO days must be a whole number." }, 400);
      }
      // A lower bound only. Negative days are not a policy disagreement, they
      // are nonsense -- an allowance cannot be less than none. The UPPER end is
      // deliberately unbounded: capping it would be Beacon inventing a policy
      // the department never stated.
      if (n < 0) {
        return json({ error: "PTO days cannot be negative." }, 400);
      }
      if (n > 366) {
        return json({ error: "PTO days cannot exceed a year." }, 400);
      }
      days = n;
    }

    // ---- scope check -----------------------------------------------------
    // *** Being an admin of YOUR department must never confer the ability to
    // write a membership row anywhere else in the database. The service role
    // would happily do it. *** Same reasoning as reset_password.
    // ACTIVE only: a departed person's allowance is history, not a setting.
    const { data: mem, error: memErr } = await onlyActive(
      admin
        .from("memberships")
        .select("user_id")
        .eq("user_id", targetId)
        .eq("flight_department_id", deptId)
    ).limit(1);
    if (memErr) return json({ error: "Could not verify membership." }, 500);
    if (!mem || !mem.length) {
      return json({ error: "That person is not in this flight department." }, 403);
    }

    // ---- the write -------------------------------------------------------
    // .select("id") is LOAD-BEARING: an UPDATE matching nothing returns success
    // with an empty array, so without it a no-op reports as done. Filters are
    // re-stated rather than trusted from the check above, because a guard that
    // ran earlier is not a guard on the write.
    const { data: updated, error: updErr } = await onlyActive(
      admin
        .from("memberships")
        .update({ annual_pto_days: days })
        .eq("user_id", targetId)
        .eq("flight_department_id", deptId)
    ).select("id");

    if (updErr) {
      return json({ error: "Could not set PTO allowance.", detail: updErr.message }, 500);
    }
    if (!updated || !updated.length) {
      return json({ error: "That person is not in this flight department." }, 403);
    }
    return json({ ok: true, annual_pto_days: days });
  }

  // ==========================================================================
  // ACTION: change_email
  //
  // Added 14 Sep 2026. Until now the sign-in address was fixed at creation:
  // Edit person could change a name, an abbreviation and a hire date, but
  // never the email, and the first real crew were all created against
  // placeholder addresses. An email lives in TWO places -- the Auth account
  // (what they sign in with) and public.users.email (what the roster shows)
  // -- and this is the one path that can move both.
  //
  // *** THIS IS A CHANGE OF IDENTITY, SO IT IS TREATED LIKE A CHANGE OF
  // AUTHORITY. *** Whoever holds this action can point another person's
  // sign-in at an address they control and become them. Reset already allows
  // that, so the reach is not new -- but it is the question a customer's IT
  // will ask, and the answer has to be: admins of THAT department only,
  // checked server-side, and every change recorded in membership_changes.
  //
  // Three writes across two systems, no shared transaction, same problem as
  // create. The order is chosen so the partial states are the survivable
  // ones, and every failure after write one puts write one back:
  //   1. Auth email (email_confirm: true -- the admin is vouching for the
  //      address, so nobody is left unable to sign in until they click a link)
  //   2. public.users.email
  //   3. audit row -- if it fails, BOTH writes are reverted. An unlogged change
  //      of sign-in identity must not stand, for the same reason grant_admin
  //      says so.
  // ==========================================================================
  if (action === "change_email") {
    const targetId = cleanStr(body.user_id, 64);
    if (!targetId) return json({ error: "Missing user." }, 400);

    const newEmail = cleanStr(body.email, 160).toLowerCase();
    if (!isEmail(newEmail)) return json({ error: "Enter a valid email address." }, 400);

    // ---- Scope check -----------------------------------------------------
    // ACTIVE only. Admin of YOUR department must never mean you can re-point
    // a sign-in anywhere else in the database, and a departed person's
    // address is not this department's to change.
    const { data: mem, error: memErr } = await onlyActive(
      admin
        .from("memberships")
        .select("user_id")
        .eq("user_id", targetId)
        .eq("flight_department_id", deptId)
    ).limit(1);
    if (memErr) return json({ error: "Could not verify membership." }, 500);
    if (!mem || !mem.length) {
      return json({ error: "That person is not in this flight department." }, 403);
    }

    // ---- The current address, for the revert and the audit row -----------
    const { data: cur, error: curErr } = await admin
      .from("users")
      .select("id, email, display_name")
      .eq("id", targetId)
      .single();
    if (curErr || !cur) return json({ error: "Could not read that person." }, 500);
    const oldEmail = String(cur.email || "").toLowerCase();
    const subjectName = String(cur.display_name || cur.email || "");

    // Same address -- say so, write nothing, record nothing. A no-op audit
    // row would describe a change that did not happen.
    if (oldEmail === newEmail) {
      return json({ ok: true, unchanged: true, email: newEmail });
    }

    // ---- Pre-flight clash on the roster copy ----------------------------
    // Auth will refuse a duplicate too, but its message is generic; this one
    // is the honest answer before anything has been touched.
    const { data: emailClash } = await admin
      .from("users")
      .select("id")
      .eq("email", newEmail)
      .neq("id", targetId)
      .limit(1);
    if (emailClash && emailClash.length) {
      return json({ error: "An account already exists for that email address." }, 409);
    }

    // ---- Who is making the change, for the audit row ---------------------
    let actorName = "";
    let actorRole = "";
    {
      const { data: me } = await admin
        .from("users")
        .select("display_name, email, role")
        .eq("id", callerId)
        .single();
      if (me) {
        actorName = String(me.display_name || me.email || "");
        actorRole = String(me.role || "");
      }
    }

    // ---- Write 1: the Auth account ---------------------------------------
    const { error: authErr } = await admin.auth.admin.updateUserById(targetId, {
      email: newEmail,
      email_confirm: true,
    });
    if (authErr) {
      const m = String(authErr.message || "");
      if (/already|exists|registered/i.test(m)) {
        return json({ error: "An account already exists for that email address." }, 409);
      }
      return json({ error: "Could not change the sign-in address.", detail: m }, 500);
    }

    // Undo helper for write 1. Swallowed on purpose: the caller needs the
    // ORIGINAL failure, not a cleanup failure. A mismatched address is
    // visible in the dashboard; a misleading error message is not.
    const revertAuth = async (): Promise<void> => {
      try {
        await admin.auth.admin.updateUserById(targetId, { email: oldEmail, email_confirm: true });
      } catch { /* see above */ }
    };

    // ---- Write 2: the roster copy ----------------------------------------
    // .select("id") is LOAD-BEARING: an UPDATE matching nothing returns
    // success with an empty array.
    const { data: updated, error: rowErr } = await admin
      .from("users")
      .update({ email: newEmail })
      .eq("id", targetId)
      .select("id");
    if (rowErr || !updated || !updated.length) {
      await revertAuth();
      return json({
        error: "Could not update the roster, so the address was not changed. Please try again.",
        detail: rowErr ? rowErr.message : "no row updated",
      }, 500);
    }

    // ---- Write 3: the audit row ------------------------------------------
    // Insert is the ONLY operation this function performs against
    // membership_changes -- see grant_admin. If this fails, both earlier
    // writes are put back and the whole thing reports as failed.
    const { error: auditErr } = await admin.from("membership_changes").insert({
      flight_department_id: deptId,
      subject_user_id: targetId,
      subject_name: subjectName,
      field_path: "email",
      field_label: "Sign-in email",
      old_value: oldEmail,
      new_value: newEmail,
      changed_by: callerId,
      changed_by_name: actorName,
      changed_by_role: actorRole,
    });
    if (auditErr) {
      await admin.from("users").update({ email: oldEmail }).eq("id", targetId).select("id");
      await revertAuth();
      return json({
        error: "Could not record the change, so it was not made. Please try again.",
        detail: auditErr.message,
      }, 500);
    }

    return json({ ok: true, email: newEmail, subject_name: subjectName });
  }

  // ==========================================================================
  // ACTION: create
  // ==========================================================================
  if (action !== "create") return json({ error: "Unknown action." }, 400);

  const email = cleanStr(body.email, 160).toLowerCase();
  const displayName = cleanStr(body.display_name, 60);
  const role = cleanStr(body.role, 40);
  const abbrev = normalizeAbbrev(body.crew_abbrev);
  const givenName = cleanStr(body.legal_given_name, 60);
  const surname = cleanStr(body.legal_surname, 60);

  if (!isEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  if (!displayName) return json({ error: "Enter a display name." }, 400);
  if (!JOB_TITLES.includes(role)) return json({ error: "Choose a job title." }, 400);
  // *** Required HERE and only here. This is the path that can finally enforce
  // it: every account from now on arrives with an abbreviation, which is what
  // eventually makes the column NOT NULL possible. ***
  if (!/^[A-Z0-9]{4}$/.test(abbrev)) {
    return json({ error: "Crew abbreviation must be exactly 4 letters or numbers." }, 400);
  }
  if (!givenName || !surname) {
    // Not a database constraint, a deliberate product rule. The legal name is
    // the key that reconciles incoming trip documents to real accounts. A null
    // one is a person the extractor can never match, and nobody notices until
    // a crew list quietly fails to resolve.
    return json({ error: "Legal given name and surname are both required." }, 400);
  }

  // Confirm the department is real before creating anything against it.
  const { data: dept, error: deptErr } = await admin
    .from("flight_departments")
    .select("id")
    .eq("id", deptId)
    .single();
  if (deptErr || !dept) return json({ error: "Flight department not found." }, 404);

  // Pre-flight uniqueness on the abbreviation.
  //
  // NOTE: users_crew_abbrev_dept_unique is on (flight_department_id,
  // crew_abbrev) using the LEGACY users.flight_department_id column, so this
  // check - and the insert below - must both use that column. The index is
  // the real guarantee; this check exists only to produce a decent error
  // message before an Auth account has been created.
  const { data: clash } = await admin
    .from("users")
    .select("id, display_name")
    .eq("flight_department_id", deptId)
    .eq("crew_abbrev", abbrev)
    .limit(1);
  if (clash && clash.length) {
    return json({
      error: 'Crew abbreviation "' + abbrev + '" is already used by ' +
        (clash[0].display_name || "someone in this department") + ".",
    }, 409);
  }

  const { data: emailClash } = await admin
    .from("users")
    .select("id")
    .eq("email", email)
    .limit(1);
  if (emailClash && emailClash.length) {
    return json({ error: "An account already exists for that email address." }, 409);
  }

  // -------------------------------------------------------------------------
  // THE THREE WRITES
  //
  // *** These span TWO SYSTEMS and cannot share a transaction. *** Write one
  // is an Admin API call against the auth schema; writes two and three are
  // ordinary SQL. There is no begin/commit that covers all three.
  //
  // The failure that matters is a half-created user: an Auth account with no
  // roster row and no membership. That person can SIGN IN SUCCESSFULLY and
  // then see nothing at all, because get_my_flight_department_ids() fails
  // closed. That is a worse state than the invite having plainly failed,
  // because it looks like a broken app rather than an unfinished setup.
  //
  // So every failure after write one deletes the Auth account. Deleting an
  // auth user CASCADES to public.users and memberships, so one delete undoes
  // all three - the same cascade that has bitten us before, useful here.
  // -------------------------------------------------------------------------
  const password = generatePassword();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    // No confirmation email: the admin hands the password over directly. This
    // is what keeps the whole operation synchronous - nothing can fail later,
    // somewhere we cannot see.
    email_confirm: true,
  });
  if (createErr || !created?.user?.id) {
    const m = String(createErr?.message || "");
    if (/already/i.test(m)) {
      return json({ error: "An account already exists for that email address." }, 409);
    }
    return json({ error: "Could not create the account.", detail: m }, 500);
  }
  const newId = created.user.id;

  // Undo helper. Any failure past this point must leave nothing behind.
  const rollback = async (): Promise<void> => {
    try {
      await admin.auth.admin.deleteUser(newId);
    } catch {
      // Deliberately swallowed: the caller needs the ORIGINAL failure, not a
      // cleanup failure. A stranded account is visible in the dashboard; a
      // misleading error message is not.
    }
  };

  const { error: rowErr } = await admin.from("users").insert({
    id: newId,
    email,
    display_name: displayName,
    role,
    crew_abbrev: abbrev,
    legal_given_name: givenName,
    legal_surname: surname,
    // Legacy column, still load-bearing: it is half of the crew-abbrev unique
    // index. Do not drop it until that index is rebuilt on memberships.
    flight_department_id: deptId,
  });
  if (rowErr) {
    await rollback();
    return json({ error: "Could not create the profile.", detail: rowErr.message }, 500);
  }

  // *** ONE SCOPE ONLY. *** memberships_one_scope requires a row to name
  // EITHER a department OR a company, never both - company_id stays NULL on a
  // department membership. This is not a quirk: company-level access is
  // SUMMARY ONLY and is a different kind of row, not a superset bolted on.
  // Supplying both is exactly what failed when Kayla was added by hand.
  const { error: memErr2 } = await admin.from("memberships").insert({
    user_id: newId,
    flight_department_id: deptId,
    membership_role: "member",
    is_admin: false, // Never granted at creation. Admin access is its own act.
  });
  if (memErr2) {
    await rollback();
    return json({ error: "Could not add them to the department.", detail: memErr2.message }, 500);
  }

  return json({ ok: true, user_id: newId, password });
});
