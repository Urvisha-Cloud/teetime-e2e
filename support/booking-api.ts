import { expect, type Page } from "@playwright/test";
import { env } from "./env";
import { unwrap } from "./network";

/**
 * The backend calls the tests make themselves — the same ones the booking site makes (wallet, gift card, membership,
 * a booking, cancel) — run inside the page with the signed-in user's session. BookingApp, the page object of the
 * booking site, builds on this class, so every test reaches them as app.walletBalance(), app.fetchBooking() ….
 */
export class BookingApi {
  constructor(readonly page: Page) {}

  /**
   * fetch() inside the page with the signed-in user's session, the way the app's axios interceptor sends it:
   * `Authorization: Bearer <authToken cookie>` plus `x-custom-access-id` = the user id in the JWT (the API's auth
   * middleware requires both). Runs in the page, so the token is never logged or written anywhere.
   */
  protected async authedFetch(
    url: string,
    { method = "GET", body }: { method?: string; body?: unknown } = {},
  ): Promise<{ ok: boolean; status: number; body: any }> {
    if (!this.page.url().startsWith(env.baseURL)) await this.page.goto("/book-now");
    return this.page.evaluate(
      async ({ url, method, body }) => {
        const m = document.cookie.match(/(?:^|; )authToken=([^;]+)/);
        let token = m ? decodeURIComponent(m[1]) : localStorage.getItem("authToken") ?? "";
        try {
          token = JSON.parse(token);
        } catch {
          /* plain string */
        }
        let userId = "";
        try {
          userId = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).id ?? "";
        } catch {
          /* leave empty; the API answers 401 and the caller's status check shows it */
        }
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "x-custom-access-id": userId };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
      },
      { url, method, body },
    );
  }

  async walletBalance(): Promise<number> {
    const { status, body } = await this.authedFetch(`${env.apiURL}/wallet/balance`);
    expect(status, "GET /wallet/balance").toBe(200);
    return Number(unwrap<any>(body)?.balance ?? 0);
  }


  async membership(): Promise<any | null> {
    const { status, body } = await this.authedFetch(`${env.apiURL}/membership/me`);
    expect(status, "GET /membership/me").toBe(200);
    const data = unwrap<any>(body);
    return data && typeof data === "object" && data.status ? data : null;
  }

  /** A gift card as the app checks it (GET /giftCode/validate/:code): what is left on it, or why it cannot be used. */
  async giftCard(code: string): Promise<{ valid: boolean; balance: number; message: string }> {
    const { status, body } = await this.authedFetch(`${env.apiURL}/giftCode/validate/${encodeURIComponent(code)}`);
    expect(status, "GET /giftCode/validate").toBe(200);
    const balance = body?.isValid ? Math.round((Number(body.data.amount) - Number(body.data.usedAmount)) * 100) / 100 : 0;
    return { valid: body?.isValid === true, balance, message: String(body?.message ?? "") };
  }

  /** What is left on a gift card that was already used in this run; 0 when it is used up. */
  async giftCardBalance(code: string): Promise<number> {
    const { valid, balance, message } = await this.giftCard(code);
    if (!valid) expect(message, "a gift card without a balance is used up").toMatch(/exhausted/i);
    return balance;
  }

  /** The wallet's transaction history, newest first (GET /wallet/transactions). */
  async walletTransactions(): Promise<any[]> {
    const { status, body } = await this.authedFetch(`${env.apiURL}/wallet/transactions`);
    expect(status, "GET /wallet/transactions").toBe(200);
    const list = unwrap<any>(body)?.transactions;
    return Array.isArray(list) ? list : [];
  }

  async fetchBooking(bookingId: string): Promise<any> {
    const { status, body } = await this.authedFetch(`${env.apiURL}/booking/${bookingId}`);
    expect(status, `GET /booking/${bookingId}`).toBe(200);
    return unwrap<any>(body);
  }

  // ───────────────────────────── cleanup ─────────────────────────────

  /**
   * Opt-in (TEETIME_CLEANUP=true): cancel through the app's own endpoint used by the Cancel flow
   * (useCancelBookingMutation -> PATCH /booking/cancel/:id?wantRefund=true). Runs in the page so the
   * app's session is used; the token is never logged or written anywhere.
   */
  async cancelBooking(bookingId: string): Promise<{ ok: boolean; status: number }> {
    const { ok, status } = await this.authedFetch(`${env.apiURL}/booking/cancel/${bookingId}?wantRefund=true`, {
      method: "PATCH",
      body: { refundType: "partial", cancelAsUser: true, cancellationReason: "Automated E2E test cleanup" },
    });
    return { ok, status };
  }

  /**
   * Ids of the logged-in user's ACTIVE (not cancelled) bookings from yesterday to 4 days ahead, via the app's
   * own endpoint GET /booking/getMyBookings (it only returns active bookings). Used by negative tests to prove
   * that a failed payment left no booking behind.
   */
  async myActiveBookingIds(): Promise<string[]> {
    const now = Date.now();
    const start = new Date(now - 24 * 3600e3).toISOString();
    const end = new Date(now + 4 * 24 * 3600e3).toISOString();
    const result = await this.authedFetch(`${env.apiURL}/booking/getMyBookings?startDate=${start}&endDate=${end}`);
    expect(result.status, "GET /booking/getMyBookings").toBe(200);
    const list = unwrap<any[]>(result.body) ?? [];
    return (Array.isArray(list) ? list : []).filter((b) => !b.isCancelled).map((b) => String(b.id));
  }
}
