"use client";

import { useCallback, useEffect, useState } from "react";
import { QrScanner } from "./qr-scanner";

type User = {
  id: number;
  site: string;
  moodleUserid: number;
  fullname: string | null;
  username: string | null;
  sitename?: string;
  connected: boolean;
  error?: string;
};

type AttendResult = { id: number; fullname: string | null; ok: boolean; message: string };

type Mode = "add-user" | "attend" | null;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

function initials(name: string | null) {
  return (name ?? "?")
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function Home() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [results, setResults] = useState<AttendResult[] | null>(null);
  const [status, setStatus] = useState("");

  const refresh = useCallback(async () => {
    const r = await fetch("/api/users");
    setUsers((await r.json()) as User[]);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    refresh();
  }, [refresh]);

  const onScan = async (payload: string) => {
    const current = mode;
    setMode(null);
    setBusy(true);
    setNotice(null);
    try {
      if (current === "add-user") {
        const u = await postJson<{ fullname: string; username: string }>("/api/users", { payload });
        setNotice({ ok: true, text: `Added ${u.fullname} (${u.username}).` });
        await refresh();
      } else {
        setResults(null);
        const r = await postJson<AttendResult[]>("/api/attend", { payload, status });
        setResults(r);
        const ok = r.filter((x) => x.ok).length;
        setNotice({ ok: ok === r.length, text: `Marked ${ok} of ${r.length} users.` });
      }
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: User) => {
    if (!confirm(`Remove ${u.fullname ?? "this user"}?`)) return;
    await fetch(`/api/users/${u.id}`, { method: "DELETE" });
    await refresh();
  };

  const connected = users?.filter((u) => u.connected).length ?? 0;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">HUJI Attend</h1>
        <p className="text-sm text-zinc-500">
          Scan one class QR and mark attendance for every connected Moodle account.
        </p>
      </header>

      {notice && (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            notice.ok
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
              : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
          }`}
        >
          {notice.text}
        </div>
      )}

      <section className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="font-semibold">Mark attendance</h2>
        <p className="mb-4 text-sm text-zinc-500">
          Scan the class QR shown by the lecturer. It rotates, so scan the current one.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            disabled={busy || connected === 0}
            onClick={() => setMode("attend")}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900"
          >
            {busy ? "Working…" : `Scan class QR for ${connected} user${connected === 1 ? "" : "s"}`}
          </button>
          <input
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="Status (default: Present / נוכח)"
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
          />
        </div>

        {results && (
          <ul className="mt-4 divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            {results.map((r) => (
              <li key={r.id} className="flex gap-3 py-2">
                <span className={r.ok ? "text-emerald-600" : "text-red-600"}>{r.ok ? "✓" : "✗"}</span>
                <span className="font-medium">{r.fullname ?? `User #${r.id}`}</span>
                <span className="flex-1 text-zinc-500">{r.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold">Users</h2>
            <p className="text-sm text-zinc-500">
              {users ? `${connected} of ${users.length} connected` : "Checking tokens…"}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={refresh}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
            >
              Refresh
            </button>
            <button
              disabled={busy}
              onClick={() => setMode("add-user")}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900"
            >
              Add user
            </button>
          </div>
        </div>

        {users?.length === 0 && (
          <p className="text-sm text-zinc-500">
            No users yet. Click <b>Add user</b> and scan the Moodle profile QR.
          </p>
        )}
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {users?.map((u) => (
            <li key={u.id} className="flex items-center gap-3 py-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-sm font-semibold dark:bg-zinc-800">
                {initials(u.fullname)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{u.fullname ?? `Moodle user ${u.moodleUserid}`}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      u.connected
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                        : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                    }`}
                  >
                    {u.connected ? "connected" : "token invalid"}
                  </span>
                </div>
                <div className="truncate text-xs text-zinc-500">
                  {u.username} · id {u.moodleUserid} · {u.sitename ?? u.site}
                </div>
                {!u.connected && u.error && <div className="truncate text-xs text-red-600">{u.error}</div>}
              </div>
              <button
                onClick={() => remove(u)}
                className="text-sm text-zinc-400 hover:text-red-600"
                aria-label={`Remove ${u.fullname}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      {mode && (
        <QrScanner
          title={mode === "add-user" ? "Add user" : "Scan class QR"}
          hint={
            mode === "add-user"
              ? "Moodle → Profile → 'QR code for mobile app access'. It expires ~10 min after the page loads and must be scanned from the same network."
              : "Point the camera at the attendance QR."
          }
          onResult={onScan}
          onClose={() => setMode(null)}
        />
      )}
    </main>
  );
}
