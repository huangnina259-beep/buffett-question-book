import { contentVersion } from "../../../lib/server/content";
import { json, routeError } from "../../../lib/server/http";
import { getOrCreateSession } from "../../../lib/server/session";

export async function GET(request: Request) {
  try {
    const { session, cookie } = await getOrCreateSession(request);
    return json({ csrfToken: session.csrfToken, generationEnabled: false, contentVersion, feedbackEnabled: true },
      200, cookie ? { "Set-Cookie": cookie } : undefined);
  } catch (error) {
    return routeError(error, "The preview session could not be started. Please try again shortly.");
  }
}
