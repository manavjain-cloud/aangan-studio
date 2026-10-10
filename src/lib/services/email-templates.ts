import { CRITERION_LABELS } from "../domain/types";
import { formatDateTimeInZone } from "../time";
import type { EnquiryBundle } from "./enquiry-data";
import type { escalations } from "../db/schema";

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Row = [label: string, value: string | null | undefined];

function layout(title: string, intro: string, sections: Array<{ heading: string; rows?: Row[]; list?: string[]; paragraph?: string }>, footer: string): string {
  const body = sections
    .map((s) => {
      const rows = (s.rows ?? [])
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 14px 4px 0;color:#5b6472;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0;color:#0f172a">${esc(v)}</td></tr>`,
        )
        .join("");
      const list = (s.list ?? []).map((l) => `<li style="margin:3px 0">${esc(l)}</li>`).join("");
      return `<h3 style="font:600 13px Inter,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#8a6d3b;margin:22px 0 6px">${esc(s.heading)}</h3>${
        rows ? `<table style="border-collapse:collapse;font:14px Inter,Arial,sans-serif">${rows}</table>` : ""
      }${list ? `<ul style="margin:4px 0 0 18px;padding:0;font:14px Inter,Arial,sans-serif;color:#0f172a">${list}</ul>` : ""}${
        s.paragraph ? `<p style="font:14px/1.55 Inter,Arial,sans-serif;color:#0f172a;margin:4px 0">${esc(s.paragraph)}</p>` : ""
      }`;
    })
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#f4f1ea"><div style="max-width:620px;margin:0 auto;padding:28px 24px;background:#fbf9f4">
<div style="font:400 26px Georgia,'Times New Roman',serif;color:#0f172a;letter-spacing:-.5px">${esc(title)}</div>
<p style="font:15px/1.5 Inter,Arial,sans-serif;color:#334155;margin:8px 0 0">${esc(intro)}</p>${body}
<p style="font:12px/1.5 Inter,Arial,sans-serif;color:#7a8494;margin:28px 0 0;border-top:1px solid #e3ddd0;padding-top:12px">${esc(footer)}</p></div></body></html>`;
}

function toText(title: string, intro: string, sections: Array<{ heading: string; rows?: Row[]; list?: string[]; paragraph?: string }>, footer: string): string {
  const out = [title, "", intro];
  for (const s of sections) {
    out.push("", s.heading.toUpperCase());
    for (const [k, v] of s.rows ?? []) if (v) out.push(`${k}: ${v}`);
    for (const l of s.list ?? []) out.push(`- ${l}`);
    if (s.paragraph) out.push(s.paragraph);
  }
  out.push("", footer);
  return out.join("\n");
}

const FOOTER = "Sent automatically by Aangan Studio's phone qualification system. Designers and front desk do not need dashboard access - everything required is in this email.";

function budgetLine(b: EnquiryBundle): string | null {
  const f = b.facts;
  if (f.budget_inr_min || f.budget_inr_max) {
    const fmt = (n: number) => `Rs ${n.toLocaleString("en-IN")}`;
    const lo = f.budget_inr_min, hi = f.budget_inr_max;
    return `Caller volunteered ${lo && hi && lo !== hi ? `${fmt(lo)} - ${fmt(hi)}` : fmt((hi ?? lo)!)} (not asked for)`;
  }
  return f.budget_declined ? "Caller preferred not to share" : "Not discussed";
}

function timelineLine(b: EnquiryBundle): string {
  const f = b.facts;
  const parts = [
    f.desired_completion_date ? `Complete by ${f.desired_completion_date}` : f.timeline_flexible ? "No fixed deadline" : "Not stated",
    f.site_available_date ? `site available from ${f.site_available_date}` : f.site_available_now ? "site available now" : null,
  ].filter(Boolean);
  return parts.join("; ");
}

function projectLine(b: EnquiryBundle): string {
  const f = b.facts;
  return [
    f.project_type, f.property_kind?.replace(/_/g, " "), f.scope?.replace(/_/g, " "), f.bhk ? `${f.bhk}BHK` : null,
    f.carpet_area_sqft ? `~${f.carpet_area_sqft} sq ft carpet` : null, f.rooms_description,
  ].filter(Boolean).join(" | ") || "Not captured";
}

function evidenceList(b: EnquiryBundle): string[] {
  return (b.qualification?.criteria ?? []).map(
    (c) => `${CRITERION_LABELS[c.criterion]}: ${c.status.toUpperCase().replace("_", " ")} (${c.points}/${c.weight}) - ${c.evidence}`,
  );
}

export function handoffEmail(b: EnquiryBundle): EmailContent {
  const name = b.contact?.name ?? b.facts.caller_name ?? "Unnamed caller";
  const locality = b.facts.location_text ?? "location unknown";
  const booked = !!b.booking;
  const tz = b.booking?.designerTimezone ?? b.booking?.customerTimezone ?? "Asia/Kolkata";
  const bookingLine = booked
    ? `${formatDateTimeInZone(b.booking!.startTime, tz)} - confirmed in Calendly${b.booking!.mode !== "live" ? " (SIMULATED - not a real booking)" : ""}`
    : "No consultation booked yet";
  const next = booked
    ? "Prepare for the consultation using the context below. Do not re-ask the caller the questions already covered."
    : "Call the customer back to arrange the consultation. The caller was qualified but no slot was booked on the call.";
  const caveats = b.qualification ? (b.qualification.caveats as string[]) : [];
  const sections = [
    { heading: "Customer", rows: [["Name", name], ["Phone", b.contact?.phoneE164], ["Email", b.contact?.email ?? b.facts.caller_email]] as Row[] },
    {
      heading: "Project",
      rows: [
        ["Type / scope", projectLine(b)], ["Location", locality], ["Site", b.facts.site_condition?.replace(/_/g, " ") ?? null],
        ["Timeline", timelineLine(b)], ["Decision-maker", b.facts.authority?.replace(/_/g, " ") ?? "Not established"],
        ["Budget", budgetLine(b)], ["Asked about pricing", b.facts.asked_about_pricing ? "Yes - deflected, no figure was quoted" : null],
      ] as Row[],
    },
    { heading: "Consultation", rows: [["Booking", bookingLine], ["Designer", b.designer?.name]] as Row[] },
    { heading: `Qualification: ${b.qualification?.disposition ?? "n/a"} (score ${b.qualification?.score ?? "-"}/100)`, list: evidenceList(b) },
    ...(caveats.length ? [{ heading: "Uncertainties to resolve", list: caveats }] : []),
    { heading: "Call summary", paragraph: b.enquiry.summary ?? "Summary not available." },
    ...(b.enquiry.handoffNote ? [{ heading: "Handoff note", paragraph: b.enquiry.handoffNote }] : []),
    { heading: "Next action", paragraph: next },
  ];
  const intro = booked ? "A qualified enquiry has been handed off with a booked consultation." : "A qualified enquiry needs a consultation arranged.";
  const title = `Qualified lead: ${name}`;
  return {
    subject: `${booked ? "Consultation booked" : "Qualified lead - arrange consultation"}: ${name}, ${locality}`,
    html: layout(title, intro, sections, FOOTER),
    text: toText(title, intro, sections, FOOTER),
  };
}

type EscalationRow = typeof escalations.$inferSelect;

const ESCALATION_TITLES: Record<string, string> = {
  existing_customer_complaint: "Existing-customer complaint",
  frustrated_returning_lead: "Frustrated returning lead",
  senior_requested: "Caller asked for a senior person",
  borderline_review: "Human decision needed on an enquiry",
  booking_failure: "Consultation booking needs human follow-up",
  integration_failure: "Integration failure needs attention",
  compliance_flag: "Compliance flag on a call",
  post_call_review: "Post-call review needed",
  other: "Human follow-up needed",
};

export function escalationEmail(esc_: EscalationRow, b: EnquiryBundle | null): EmailContent {
  const name = b?.contact?.name ?? b?.facts.caller_name ?? "Unnamed caller";
  const label = ESCALATION_TITLES[esc_.kind] ?? "Human follow-up needed";
  const urgent = esc_.urgency === "high";
  const sections = [
    { heading: "Why this reached you", paragraph: esc_.reason },
    { heading: "Requested response", paragraph: esc_.requestedResponse ?? "Review and respond." },
    ...(b
      ? [
          { heading: "Customer", rows: [["Name", name], ["Phone", b.contact?.phoneE164], ["Email", b.contact?.email ?? b.facts.caller_email], ["Location", b.facts.location_text]] as Row[] },
          { heading: "Project", rows: [["Type / scope", projectLine(b)], ["Timeline", timelineLine(b)]] as Row[] },
          ...(b.qualification && esc_.kind !== "existing_customer_complaint"
            ? [{ heading: `Qualification so far: ${b.qualification.disposition} (score ${b.qualification.score}/100)`, list: evidenceList(b) }]
            : []),
          { heading: "Call summary", paragraph: b.enquiry.summary ?? "Summary not yet available (call may still be in progress or being processed)." },
        ]
      : []),
    { heading: "Handling notes", list: [
      esc_.kind === "existing_customer_complaint" ? "This is an existing customer, not a sales lead. The AI did not attempt to resolve the issue." : "The AI made no commitment on the caller's behalf.",
      "No price was quoted and no completion date was promised.",
    ] },
  ];
  const title = `${urgent ? "[URGENT] " : ""}${label}`;
  return {
    subject: `${urgent ? "[URGENT] " : ""}${label}: ${name}`,
    html: layout(title, `Escalation status: ${esc_.status}.`, sections, FOOTER),
    text: toText(title, `Escalation status: ${esc_.status}.`, sections, FOOTER),
  };
}

export function droppedCallEmail(b: EnquiryBundle, whenIst: string): EmailContent {
  const name = b.contact?.name ?? b.facts.caller_name ?? "Unknown caller";
  const sections = [
    { heading: "What happened", paragraph: "The caller was disconnected (or hung up) before the qualification conversation finished. No consultation was booked." },
    { heading: "Caller", rows: [["Name", name], ["Phone", b.contact?.phoneE164], ["Call time", whenIst]] as Row[] },
    { heading: "What was captured before the call dropped", rows: [["Project", projectLine(b)], ["Location", b.facts.location_text], ["Timeline", timelineLine(b)]] as Row[] },
    { heading: "Next action", paragraph: "Call the number back. Do not re-ask what is listed above." },
  ];
  return {
    subject: `Call-back needed: dropped call from ${name}`,
    html: layout("Call-back needed", "A caller was cut off before we could finish.", sections, FOOTER),
    text: toText("Call-back needed", "A caller was cut off before we could finish.", sections, FOOTER),
  };
}

export function opsAlertEmail(title: string, detail: string): EmailContent {
  const sections = [{ heading: "Detail", paragraph: detail }, { heading: "What to do", paragraph: "Check the Integrations page in the management dashboard and the README troubleshooting section." }];
  return {
    subject: `[Ops] ${title}`,
    html: layout(title, "An operational problem needs attention.", sections, FOOTER),
    text: toText(title, "An operational problem needs attention.", sections, FOOTER),
  };
}
