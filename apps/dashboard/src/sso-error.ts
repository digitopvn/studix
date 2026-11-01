/** Messages for the `?error=` codes Better Auth appends when an OAuth sign-in or link fails. */
const MESSAGES: Record<string, string> = {
  account_not_linked:
    "A Studix account with this email already exists and was not linked automatically. If it is yours, sign in to it and link GitHub or Google from Account; otherwise contact support.",
  email_not_verified: "Your provider has not verified this email address, so no account was created.",
  unable_to_create_user: "The account could not be created. Try again.",
  unable_to_link_account: "The provider has not verified this email address, so it was not linked.",
  email_does_not_match: "The provider account uses a different email than your Studix account.",
  account_already_linked_to_different_user: "This provider account is already linked to another Studix user.",
  state_mismatch: "The sign-in request expired or was opened in another browser. Try again.",
  access_denied: "Sign-in was cancelled at the provider.",
};

/**
 * Read and clear the OAuth error code from the URL so a reload does not show it again. Returns a message,
 * or undefined when the URL carries none.
 */
export function takeSsoError(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("error");
  if (!code) return undefined;
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  return MESSAGES[code] ?? "Single sign-on failed. Try again or sign in with your password.";
}
