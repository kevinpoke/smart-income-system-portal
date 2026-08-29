// Admin-portal batch: single, shared, pure ISP "Action" classifier for
// the /admin/isp-approvals table. Reuses the EXACT SAME authoritative
// isp_status value every other ISP consumer in this app already reads
// (accounts.isp_status via lib/ispEngine.js's state machine) -- this is
// NOT a new/duplicate ISP state field, just a display-label mapping over
// the two isp_status values this page's list query already restricts to
// (see app/api/admin/accounts/route.js's `ispStatus=pending_review,
// approved_awaiting_user` param, used by
// app/(portal)/admin/isp-approvals/page.js).
//
// Both the Action FILTER (which isp_status values to request/show) and
// the Action COLUMN (which button/label to render for a given row) call
// this SAME function, so they can never disagree about what "Approve"
// vs "ISP Confirmation" means for a given account.
export const ISP_ACTION = {
  APPROVE: "approve",
  ISP_CONFIRMATION: "isp_confirmation",
};

// Returns one of ISP_ACTION's two values for any row this page's query
// can return (pending_review | approved_awaiting_user), or null for any
// other isp_status (defensive -- this page's own query never actually
// returns another status, but a caller should not silently mis-render
// an unexpected value as "Approve").
export function computeIspAction(ispStatus) {
  if (ispStatus === "approved_awaiting_user") return ISP_ACTION.ISP_CONFIRMATION;
  if (ispStatus === "pending_review") return ISP_ACTION.APPROVE;
  return null;
}

// Maps an Action-filter selection ("all" | "approve" | "isp_confirmation")
// to the exact comma-separated isp_status value this page's existing
// server-side `ispStatus` query param already accepts (see
// app/api/admin/accounts/route.js) -- filtering by Action is really just
// filtering by isp_status under the hood, reusing the EXISTING
// server-side filter mechanism rather than inventing a new one. Falls
// back to the full "all" set for an unrecognized value.
const ALL_ISP_STATUSES = "pending_review,approved_awaiting_user";
export function ispActionFilterToIspStatusParam(actionFilter) {
  if (actionFilter === ISP_ACTION.APPROVE) return "pending_review";
  if (actionFilter === ISP_ACTION.ISP_CONFIRMATION) return "approved_awaiting_user";
  return ALL_ISP_STATUSES;
}

export const ISP_ACTION_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: ISP_ACTION.APPROVE, label: "Approve" },
  { value: ISP_ACTION.ISP_CONFIRMATION, label: "ISP Confirmation" },
];
