import type { Page, Request, Response } from "@playwright/test";
import { env } from "./env";

const UUID = "[0-9a-fA-F-]{36}";
/** POST /booking/:locationId/:bayId  (useCreateBookingMutation) */
export const CREATE_BOOKING_RE = new RegExp(`/booking/${UUID}/${UUID}(\\?.*)?$`);
/** GET /booking/get-every?locationId=..&fromDate=..  (useGetBookingsData) */
export const LIST_BOOKINGS_RE = /\/booking\/get-every(\?|$)/;
/** GET /booking/:id  (BookingCheckout getBookingById) */
export const GET_BOOKING_RE = new RegExp(`/booking/(${UUID})(\\?.*)?$`);
/** GET /location/get-location-with-bays  (LocationContext) */
export const LOCATIONS_RE = /\/location\/get-location-with-bays(\?|$)/;

export interface ApiLocation {
  id: string;
  name: string;
  timezone?: { value?: string; label?: string };
  bays?: { id: string; name: string; type?: string; order?: number; isActive?: boolean }[];
}

/** Unwraps `{ data: X }` envelopes the API may use. */
export function unwrap<T = any>(body: any): T {
  let cur = body;
  for (let i = 0; i < 3 && cur && typeof cur === "object" && !Array.isArray(cur) && "data" in cur; i++) {
    cur = cur.data;
  }
  return cur as T;
}

/**
 * Passive recorder of the app's own API traffic. Used only for verification —
 * the booking journey itself is always driven through the UI.
 */
export class ApiRecorder {
  readonly createRequests: Request[] = [];
  readonly createResponses: { status: number; body: any }[] = [];
  locations: ApiLocation[] = [];
  lastBookingList: any[] | null = null;
  lastBookingListUrl: string | null = null;

  private readonly onRequestListener = (req: Request) => {
    if (req.method() === "POST" && req.url().startsWith(env.apiURL) && CREATE_BOOKING_RE.test(req.url())) {
      this.createRequests.push(req);
    }
  };
  private readonly onResponseListener = (res: Response) => void this.onResponse(res);

  constructor(private readonly page: Page) {
    page.on("request", this.onRequestListener);
    page.on("response", this.onResponseListener);
  }

  /** Stop recording. Needed because tests share one page (one browser window) for the whole run. */
  detach() {
    this.page.off("request", this.onRequestListener);
    this.page.off("response", this.onResponseListener);
  }

  private async onResponse(res: Response) {
    const url = res.url();
    if (!url.startsWith(env.apiURL)) return;
    const method = res.request().method();
    try {
      if (method === "POST" && CREATE_BOOKING_RE.test(url)) {
        this.createResponses.push({ status: res.status(), body: await res.json().catch(() => null) });
      } else if (method === "GET" && LOCATIONS_RE.test(url) && res.ok()) {
        const list = unwrap<any>(await res.json());
        if (Array.isArray(list)) this.locations = list;
      } else if (method === "GET" && LIST_BOOKINGS_RE.test(url) && res.ok()) {
        const list = unwrap<any>(await res.json());
        if (Array.isArray(list)) {
          this.lastBookingList = list;
          this.lastBookingListUrl = url;
        }
      }
    } catch {
      /* body unavailable (navigation) — ignore */
    }
  }

  location(name: string): ApiLocation | undefined {
    return this.locations.find((l) => l.name === name);
  }
}
