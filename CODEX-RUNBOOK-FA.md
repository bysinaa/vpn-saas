# راهنمای اجرای کار با Codex — XUI Installer

این فایل برای خودت است، نه دستور دائمی Agent.

## یک‌بار برای همیشه

این فایل‌ها را در ریشه repo قرار بده:

- `AGENTS.md`
- `XUI-INSTALLER-STATE.md`

و این پوشه را بساز:

`docs/exec-plans/xui-installer/`

داخلش:

- `INDEX.md`
- `01-cleanup.md`
- `02-discovery.md`
- `03-auth-reconcile.md`
- `04-drift.md`
- `05-verify.md`

همه را commit کن.

---

# قانون اصلی

پرامپت هیولای قبلی را دیگر به Codex نده.

در هر Session فقط:
1. AGENTS
2. STATE
3. INDEX
4. فایل همان Phase

را بخواند.

بعد فقط همان Phase را انجام دهد.

Session هر Phase را جدا نگه دار تا Context قبلی بی‌دلیل بزرگ نشود.

---

# Session 1 — Cleanup

این را عیناً به Codex بده:

Read `AGENTS.md`, `XUI-INSTALLER-STATE.md`, `docs/exec-plans/xui-installer/INDEX.md`, and `docs/exec-plans/xui-installer/01-cleanup.md`.

Execute Phase 1 completely against the real code. Perform the evidence-based Ponytail cleanup, run the required focused checks, and update `XUI-INSTALLER-STATE.md`.

Do not start Phase 2 and do not touch payment/business logic.

وقتی تمام شد:
- خروجی Codex را بخوان.
- مطمئن شو تست‌ها واقعاً اجرا شده‌اند.
- diff را نگاه کن.
- اگر خوب بود commit بزن.

اگر Codex وسط کار Context کم آورد، فقط بگو:

Update `XUI-INSTALLER-STATE.md` with all verified findings, completed changes, tests, and the exact next step. Stop after the state file is complete.

بعد یک Session جدید باز کن و دوباره همان Phase را از STATE ادامه بده.

---

# Session 2 — Discovery

Session جدید باز کن.

فقط این را بده:

Continue the XUI installer work.

Read `AGENTS.md`, `XUI-INSTALLER-STATE.md`, `docs/exec-plans/xui-installer/INDEX.md`, and `docs/exec-plans/xui-installer/02-discovery.md`.

Execute Phase 2 completely. Use current upstream 3x-ui source when behavior is version-sensitive. Run focused tests and update `XUI-INSTALLER-STATE.md`.

Do not start Phase 3.

بعد review و commit.

---

# Session 3 — Auth + Reconciliation

Session جدید:

Continue the XUI installer work.

Read `AGENTS.md`, `XUI-INSTALLER-STATE.md`, `docs/exec-plans/xui-installer/INDEX.md`, and `docs/exec-plans/xui-installer/03-auth-reconcile.md`.

Execute Phase 3 completely against the real runtime architecture. Reuse existing panel/inbound services where correct instead of creating duplicate paths. Run focused tests and update `XUI-INSTALLER-STATE.md`.

Do not start Phase 4.

بعد review و commit.

---

# Session 4 — Drift

Session جدید:

Continue the XUI installer work.

Read `AGENTS.md`, `XUI-INSTALLER-STATE.md`, `docs/exec-plans/xui-installer/INDEX.md`, and `docs/exec-plans/xui-installer/04-drift.md`.

Execute Phase 4 completely. Keep drift detection reusable and do not turn the CLI into a permanent polling daemon. Run focused tests and update `XUI-INSTALLER-STATE.md`.

Do not start Phase 5.

بعد review و commit.

---

# Session 5 — Final Verify

Session جدید:

Finish the XUI installer work.

Read `AGENTS.md`, `XUI-INSTALLER-STATE.md`, `docs/exec-plans/xui-installer/INDEX.md`, and `docs/exec-plans/xui-installer/05-verify.md`.

Execute Phase 5 completely. Run the full relevant regression checks, remove remaining fake success paths, finalize the safe diagnostic command, and update `XUI-INSTALLER-STATE.md`.

Do not claim a real Linux/3x-ui integration test unless one actually ran.

بعد review و commit.

---

# اگر Codex اشتباه رفت سراغ چیزهای دیگر

فقط این را بده:

Stay inside the current XUI installer phase. Do not touch payment, wallet, Telegram purchase, or subscription business logic. Use `XUI-INSTALLER-STATE.md` as the verified handoff and avoid rescanning unrelated modules.

---

# اگر شروع کرد دوباره همه repo را از صفر بخواند

بگو:

Do not repeat repository-wide discovery already recorded in `XUI-INSTALLER-STATE.md`. Verify only facts affected by changed code and inspect the files required by the current phase.

---

# اگر فقط Report داد و کد نزد

بگو:

This is an implementation task, not a report task. Apply the required code changes now, run the focused tests, and update `XUI-INSTALLER-STATE.md` with verified results.

---

# اگر کلی فایل compatibility نگه داشت

بگو:

For every compatibility wrapper or legacy installer path you want to keep, show its current executable caller. If none exists, remove it and update affected tests/build references.

---

# اگر خواست 3x-ui password را حدس بزند/reset کند

متوقفش کن و بگو:

Do not guess, recover, or reset 3x-ui credentials. Preserve non-secret discovery, return AUTH_REQUIRED, and use the existing encrypted TAZAXY credential path after explicit validated authentication.

---

# مهم‌ترین نکته برای مصرف Token

هر Phase = یک Session جدید.

پرامپت‌های بالا را کوتاه نگه دار.

اطلاعات دائمی داخل `AGENTS.md`.
نقشه داخل `INDEX.md`.
جزئیات هر مرحله داخل فایل Phase.
حافظه بین Sessionها داخل `XUI-INSTALLER-STATE.md`.

اگر STATE خیلی بزرگ شد، به Codex بگو آن را compact کند:

Compact `XUI-INSTALLER-STATE.md`. Keep only currently verified architecture, decisions, modified/removed canonical files, test status, unresolved blockers, and the exact next action. Remove investigation history and stale details.

این کار جلوی رشد بی‌نهایت Context را می‌گیرد.
