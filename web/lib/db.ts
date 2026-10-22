import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { MoodleAccount } from "./moodle";

export type UserRow = {
  id: number;
  site: string;
  moodle_userid: number;
  token: string;
  private_token: string;
  fullname: string | null;
  username: string | null;
  session_cookies: string | null;
  created_at: string;
};

async function db() {
  const { env } = await getCloudflareContext({ async: true });
  return env.DB;
}

export const toAccount = (u: UserRow): MoodleAccount => ({
  site: u.site,
  userid: u.moodle_userid,
  token: u.token,
  privatetoken: u.private_token,
  session: u.session_cookies ?? undefined,
});

export async function listUsers() {
  const { results } = await (await db())
    .prepare("SELECT * FROM users ORDER BY created_at")
    .all<UserRow>();
  return results;
}

/** Insert, or refresh the tokens of an account that was already added. */
export async function upsertUser(
  account: MoodleAccount,
  info: { fullname: string; username: string },
) {
  return (await db())
    .prepare(
      `INSERT INTO users (site, moodle_userid, token, private_token, fullname, username)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (site, moodle_userid) DO UPDATE SET
         token = excluded.token,
         private_token = excluded.private_token,
         fullname = excluded.fullname,
         username = excluded.username
       RETURNING *`,
    )
    .bind(
      account.site,
      account.userid,
      account.token,
      account.privatetoken,
      info.fullname,
      info.username,
    )
    .first<UserRow>();
}

export async function updateUserInfo(id: number, info: { fullname: string; username: string }) {
  await (await db())
    .prepare("UPDATE users SET fullname = ?1, username = ?2 WHERE id = ?3")
    .bind(info.fullname, info.username, id)
    .run();
}

/** Save (or clear, with null) the Moodle browser session reused by later scans. */
export async function saveSession(id: number, session: string | null) {
  await (await db())
    .prepare("UPDATE users SET session_cookies = ?1 WHERE id = ?2")
    .bind(session, id)
    .run();
}

export async function deleteUser(id: number) {
  await (await db()).prepare("DELETE FROM users WHERE id = ?1").bind(id).run();
}
