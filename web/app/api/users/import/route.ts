import { upsertUser } from "@/lib/db";
import { errorMessage, getSiteInfo, MoodleError } from "@/lib/moodle";
import type { MoodleAccount } from "@/lib/moodle";

/**
 * Store an already-exchanged Moodle token. The QR→token exchange is IP-bound to the
 * browser that showed the profile QR, so it must happen on the local network (the
 * desktop enroller does it). This endpoint only validates the token and saves it.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as Partial<MoodleAccount>;
  const { site, userid, token, privatetoken } = body;
  if (!site || !userid || !token || !privatetoken) {
    return Response.json(
      { error: "Expected { site, userid, token, privatetoken }." },
      { status: 400 },
    );
  }
  try {
    const account: MoodleAccount = { site, userid, token, privatetoken };
    const info = await getSiteInfo(site, token);
    const user = await upsertUser(account, info);
    return Response.json({ id: user?.id, fullname: info.fullname, username: info.username });
  } catch (e) {
    const status = e instanceof MoodleError ? 400 : 502;
    return Response.json({ error: errorMessage(e) }, { status });
  }
}
