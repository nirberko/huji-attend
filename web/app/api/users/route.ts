import { listUsers, updateUserInfo, upsertUser } from "@/lib/db";
import { errorMessage, getSiteInfo, isLoginQr, loginWithQr, MoodleError } from "@/lib/moodle";

/** Connected users, each checked live against Moodle (core_webservice_get_site_info). */
export async function GET() {
  const users = await listUsers();
  const checked = await Promise.all(
    users.map(async (u) => {
      const base = {
        id: u.id,
        site: u.site,
        moodleUserid: u.moodle_userid,
        fullname: u.fullname,
        username: u.username,
        createdAt: u.created_at,
      };
      try {
        const info = await getSiteInfo(u.site, u.token);
        if (info.fullname !== u.fullname || info.username !== u.username) {
          await updateUserInfo(u.id, info);
        }
        return {
          ...base,
          fullname: info.fullname,
          username: info.username,
          sitename: info.sitename,
          connected: true,
        };
      } catch (e) {
        return { ...base, connected: false, error: errorMessage(e) };
      }
    }),
  );
  return Response.json(checked);
}

/** Add a user from a scanned profile QR ("QR code for mobile app access"). */
export async function POST(request: Request) {
  const { payload } = (await request.json()) as { payload?: string };
  if (!payload || !isLoginQr(payload)) {
    return Response.json(
      { error: "Not a profile QR — open Moodle profile → 'QR code for mobile app access'." },
      { status: 400 },
    );
  }
  try {
    const account = await loginWithQr(payload);
    const info = await getSiteInfo(account.site, account.token);
    const user = await upsertUser(account, info);
    return Response.json({ id: user?.id, fullname: info.fullname, username: info.username });
  } catch (e) {
    const status = e instanceof MoodleError ? 400 : 502;
    return Response.json({ error: errorMessage(e) }, { status });
  }
}

