# booking-and-more — User Guide

_A plain-English guide to running your business on booking-and-more: what each screen does, who is allowed to do what, how an appointment travels from your customer's phone to your team's day, and how the AI receptionist answers on your behalf._

---

## What is this, in one sentence?

It's **your own online booking page and AI receptionist, backed by a dashboard where your team manages the calendar** — so customers book themselves in at two in the morning, by form or by chat, and your staff keep full control of who is available, when, and for what.

Every business on the platform is kept entirely separate from every other: your services, your people, your locations, your customers, your conversations. Nobody else can see them.

It is built for **clinics, salons and studios** — anywhere people book time with a named person for a named service.

---

## The parts of the product

### 1. Your public booking page 🌐

A page at your own address — `yourbusiness.example.com/your-slug/book` — that anyone can open without an account. In five short steps they choose a service, choose who they want to see, pick a time from a real calendar, leave their details, and they're booked. They get an email straight away with a link they can use to change or cancel.

![The public booking page: a five-step wizard on step one, listing services with their durations, prices and short descriptions](assets/screenshots/en/public-booking-service.png)

### 2. Your AI receptionist 💬

On the **Professional** plans, customers can also simply _ask_. A chat page at `…/your-slug/chat` — and, if you want, a chat bubble on your own website — answers questions about your services, prices, people, locations and policies, finds free times, and books the appointment. It works from the same calendar and the same rules as the booking form, and the form is always one tap away.

### 3. The staff dashboard 💻

Where your team signs in. It holds the catalogue you sell (services, people, places), each provider's working hours, the day-to-day list of appointments, and — on the Professional plans — what the AI receptionist knows and every conversation it has had. Your team accepts requests, reschedules, cancels, and marks people as arrived or missed.

Everything reads the same calendar, so there is never a second diary to keep in step.

```mermaid
flowchart LR
    Customer([🌐 Customer]) --> BookingPage[Your booking page]
    Customer --> Chat[💬 AI receptionist]
    BookingPage <--> Core[(📅 One shared calendar<br/>🧾 Services and prices<br/>👥 Providers and hours)]
    Chat <--> Core
    Staff([👩‍⚕️ Your team]) --> Dashboard[💻 Staff dashboard]
    Dashboard <--> Core
    Core --> Emails[✉️ Confirmations,<br/>reminders, changes]
    Emails --> Customer
```

---

## Getting started — how you got here

booking-and-more is not something you sign up for on your own. **We set your organization up for you and email you an invitation.** That is deliberate: it means your business name, your web address and your language are right from the very first screen you see.

Here is the whole path from that email to a working booking page:

```mermaid
flowchart TD
    Invite([✉️ You receive an invitation email]) --> Open[Open the link]
    Open --> Register[Choose your own password<br/>we never send you one]
    Register --> Pending[📋 Your dashboard opens<br/>in its waiting state]
    Pending --> Plan[Choose Form, Professional<br/>or Professional Plus]
    Plan --> Link[We email you a payment link<br/>forward it to whoever pays]
    Link --> Card[Enter card details<br/>free trial starts, nothing charged yet]
    Card --> Active[🎉 Everything unlocks]
    Active --> Build[Add services, locations, providers]
    Build --> Hours[Providers set their working hours]
    Hours --> Live([🌐 Share your booking page])
    Live -.Professional plans.-> AI[💬 Write your profile and FAQs,<br/>then switch the assistant on]
```

### The invitation

The link in that email is **single-use and time-limited**. Open it, pick a password, and you are in — you become the **owner** of the organization. If you already have an account with us, you accept in one step with your existing password.

If you are already signed in as somebody else when you open it, the screen will say so plainly and offer to sign you out first. If the link has gone stale, ask us to resend it; a fresh one is issued in seconds and the old one stops working.

### The waiting state

Before your subscription starts, your dashboard shows a short welcome screen instead of the full product:

> **Welcome to {your organization}**
> Your organization is set up and waiting for its subscription. Here is what happens next.

It lists the three steps ahead — subscribe, configure, take bookings — and counts down the days you have left to subscribe. **Providers, services, locations, availability and bookings stay locked until the subscription starts.** Only two screens work: this overview, and Subscription, which is the one that resolves it.

---

## Your subscription

Open **Subscription** in the sidebar. You will see three plans:

| Plan                  | What it's for                                                                                                        | Monthly price |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------: |
| **Form**              | Dashboard and public booking form. AI chat is not included.                                                          |      9,990 Ft |
| **Professional**      | Everything in Form, plus AI chat, the website widget and conversation transcripts. 150 chats a month, up to 30 a day |     29,900 Ft |
| **Professional Plus** | Everything in Professional, with 300 chats a month, up to 30 a day                                                   |     59,800 Ft |

Prices are **VAT exempt (AAM) — no VAT is charged**. Invoices are issued through Billingo.

![The Subscription screen for an organization on the Professional plan](assets/screenshots/en/dashboard-subscription.png)

Choose one and press **Send me the payment link**. We email a secure payment page to your address — you can forward it to whoever handles the money, which is why it arrives by email rather than opening straight away.

> **Need a hand getting set up?** Assisted configuration is available for a one-time fee of 29,990 Ft — we build your catalogue and schedules with you.

### What counts as a chat

A chat is counted when a customer **starts** a conversation with the AI receptionist — once, however long it runs and even if they walk away. Opening the chat page, refreshing it, or switching language does not count again. Unused chats don't roll over, and there are **no surprise overage charges**: when the month's chats are used up, the chat says so and the booking form keeps working as normal. On a Professional plan the Subscription screen shows the running count:

> _Monthly chats: {used} / {limit}. Remaining: {remaining}. Resets at the start of each UTC month._

### The free trial

New organizations get **30 days free**. We take your card at the start but **charge nothing until the trial ends**, and you can cancel any time before then. The screen tells you exactly when: _"Your free trial ends on {date}. We will then charge for {plan}."_

An organization only gets one trial. If yours has already been used, the screen says so and billing starts immediately instead.

### Once you are subscribed

The Subscription screen becomes your billing home:

- **Manage billing** opens a secure Stripe portal where you change your card or cancel. You are brought straight back afterwards.
- **Changing plan** — an upgrade takes effect immediately; a downgrade is scheduled for the end of the period, and the screen tells you the date: _"Your plan changes to {plan} on {date}."_
- **Cancelling** doesn't cut you off mid-month. The screen switches to _"Ends on {date}"_, and you can restart any time before then.
- **A failed payment** does not switch anything off straight away. You'll see a notice asking you to update your card while your service keeps running.

---

## The Overview screen — your home page

**Dashboard → Overview** is what you see after signing in. From top to bottom:

![The Overview screen: shortcut cards for Bookings and AI Assistant above the patient QR codes for booking and chat](assets/screenshots/en/dashboard-home.png)

- **Shortcuts** to the screens you use daily — Bookings, Availability and, on a Professional plan, AI Assistant. You only see the ones you have access to.
- **Patient QR codes** — ready-to-download codes for your website, your door or your printed leaflets. Scanning opens your booking page directly; on a Professional plan there is a second code that opens the chat. **Customers do not need to install anything.**
- **What the AI receptionist knows** _(Professional plans)_ — your company profile, FAQs, contact details and the knowledge check. This has its own chapter below, _The AI receptionist_.
  ![The Members table: the owner linked to her own diary, a provider with his diary, and a front-desk assistant](assets/screenshots/en/dashboard-members.png)

- **Members** — everybody with a login, their role, and **which diary each one holds**. A provider whose row says _"No diary — cannot work yet"_ can sign in but cannot do anything; link them to their diary right there.

If you belong to more than one business, a **Choose a business…** selector at the top switches between them. Each business has its own roles, its own data and its own sidebar.

---

## Building your catalogue

Three screens, and the order matters. **Services first, then locations, then providers** — because a provider is booked _for a service_, so a provider created first has nothing to offer and cannot appear on your booking page at all.

```mermaid
flowchart LR
    S[1. Services<br/>what you sell] --> P[3. Providers<br/>who does it]
    L[2. Locations<br/>where you work] --> P
    P --> A[4. Availability<br/>when they work]
    A --> Live([Bookable online])
```

---

## Services — what you sell

**Dashboard → Services → Add a service.**

A service is one bookable thing: a check-up, a cut and colour, a 50-minute session.

![The Services screen listing five services with their duration, price and status, and Edit, Translations, Deactivate and Archive on each row](assets/screenshots/en/dashboard-services.png)

| Field                        | What it does                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Name** and **Description** | What the customer reads on the booking page — and what the AI receptionist reads too                                              |
| **Duration**                 | How long the appointment is — **this is what the customer sees**                                                                  |
| **Buffer before / after**    | Extra minutes reserved around the appointment. **Customers never see them** — use these for cleaning down a room or writing notes |
| **Price**                    | Leave it blank and the booking page says _"On request"_ instead                                                                   |
| **URL name**                 | Appears in your booking links. Leave it blank and we build one from the name                                                      |

**Short and long descriptions.** Write a short description first, then put `---` on its own line and write the detailed one beneath it. The booking page shows the short one and lets the customer open the rest.

### The three settings worth understanding

**Needs approval before it is confirmed.** Turn this on and bookings arrive as _requests_ rather than confirmed appointments. The customer is told the business will confirm shortly, and the appointment waits on your Bookings screen until somebody presses Accept. Use it where you want to vet who's coming in; leave it off where you're happy to be booked automatically.

**Minimum notice (minutes).** How close to the appointment somebody may still book. Set it to 120 and nobody can grab a slot less than two hours out.

**Book up to (days ahead).** How far into the future your calendar is open.

Both of the last two can be left blank to **inherit** the business-wide setting. Careful: _blank_ and _zero_ are different. Blank means "use the default"; zero means "bookable up to the very last second". The screen tells you which default you're inheriting, and warns you if you've set a window so short that customers will see almost nothing.

### Translations

**Translations**, on a service's row, holds its name and description in Hungarian, English, German and French. A customer reading your page — or chatting — in another language sees that language's version; where there isn't one, they see your default language.

On a Professional plan, each language has a **draft** button that fills in a machine translation from your default language. **A draft saves nothing** — read it, correct it, and only then save.

### Turning things off

Two different questions, and both are available:

- **Deactivate** — off for now. It stops appearing on the booking page and can be switched back on any moment.
- **Archive** — gone. It disappears from the working list entirely.

**Nothing is ever really deleted.** Old appointments keep pointing at the service they were booked for, so your history stays intact and correctly priced. Tick **Show archived** to see archived rows, and **Restore** to bring one back. If you try to create something and are told the name is taken, it's usually an archived row — restore it rather than making a duplicate.

---

## Locations — where you work

**Dashboard → Locations → Add a location.**

A location is one of your sites. There are four kinds:

![The Locations screen listing two clinic sites and an online location](assets/screenshots/en/dashboard-locations.png)

| Type           | Use it for                             |
| -------------- | -------------------------------------- |
| **In person**  | A physical address customers travel to |
| **Online**     | Video appointments                     |
| **Home visit** | You travel to them                     |
| **Telephone**  | Phone consultations                    |

For physical sites, fill in the address, postal code, city and country. **Map coordinates** are optional and let the booking page point at the right spot.

**Time zone** deserves a note: leave it blank and the location uses your business's own zone. Set it only if you genuinely run a site in another zone — appointments there are then shown in that zone.

> **You may not need any locations at all.** If everything you do is online or by telephone, skip this screen entirely. Locations describe where a person physically works; they are not required for a booking to happen.

---

## Providers — the people customers book

**Dashboard → Providers → Add a provider.**

A provider is somebody appointments are booked with. Note that **creating a provider does not give them a login** — that's a separate step, covered further down.

![The Providers screen listing three providers with the services and locations assigned to each](assets/screenshots/en/dashboard-providers.png)

| Field                  | What it does                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| **Name, Email, Phone** | Their record. The email is also what an invitation would be sent to                                      |
| **Languages spoken**   | Hungarian, English, German, French — shown to help customers choose                                      |
| **Bookable online**    | Turn this **off** to keep somebody off the public booking page while your team still books them by phone |
| **Default location**   | Where they normally work                                                                                 |

### Assigning services

This is the step people forget. **Until a provider is assigned at least one service, nobody can book them** — they simply will not appear on your booking page.

Use **Assign** on the provider's row to tick the services they offer. While you're there, you can override the service's own settings for this one person:

- **Duration** — leave blank to use the service's own. Set it if this provider takes 45 minutes where everyone else takes 30.
- **Price** — leave blank to inherit. (If the service has no price at all, there's nothing to override, and the screen says so.)

**Assign** is also where you add further locations beyond their default, so a provider can work Tuesdays at one site and Thursdays at another.

### Booking approval, per provider

Each provider has a **Booking approval** mode:

- **Manual** — each service's own _Needs approval_ setting applies.
- **Automatic** — every booking with this provider is confirmed immediately, whatever the service says, so neither the provider nor their assistant has an approval task.

### Archiving somebody who has a login

Archiving a provider hides their diary and takes them off the booking page. If somebody **signs in as that provider**, the confirmation warns you that they will lose access to their availability and bookings until you restore them — if you only want them off the booking page for a while, **deactivate** instead and their login keeps working.

---

## Availability — when people work

**Availability belongs to the provider.** That is a deliberate decision, not an accident of the layout: the owner decides what the business sells and where, and each provider decides when they work.

So there is no organization-wide availability screen. A provider with a login opens **Availability** and sees their own diary. An owner or administrator reaches any diary — including their own, if they also treat patients — from **Availability** on that provider's row on the Providers screen.

The screen has three tabs: **Weekly working hours**, **Exceptions**, and — for the owner — **Delegates**.

### Weekly working hours

An ordinary week. For each day, add one or more periods.

![The Availability screen's three tabs above the weekly working hours editor: Monday with two periods, 8:00 to 12:30 and 1:30 to 5:00, leaving a lunch break](assets/screenshots/en/dashboard-availability.png)

**Add a second period to a day to leave a break in the middle** — 09:00–12:30 and 13:30–17:00 gives you a lunch hour that nobody can book into. A day with no periods is simply closed.

Times are **local times in the provider's own zone**, and the screen tells you which zone that is. This matters twice a year: "Mondays 09:00–17:00" stays 09:00–17:00 on the Monday the clocks change, exactly as a human would expect.

Each period can be narrowed further:

- **Location** — where this period is worked, or _"Wherever they work"_
- **Service** — restrict a period to one service, or leave it as _"Every service"_
- **From date / Until date** — a period that only applies for part of the year

If the provider hasn't been assigned any service yet, the screen says so before you start — hours on their own produce no bookable times.

### Exceptions — one-off changes

The things a weekly pattern can't express. **Exceptions override the weekly hours.**

- **Unavailable** — a closure. Holidays, a training day, an afternoon at the dentist.
- **Extra availability** — an opening outside the normal pattern. A Saturday clinic, a late evening.

Add a **reason** if it helps your team; reasons are **staff-only and never shown to customers**.

If you pick a time that daylight saving has eaten, the screen tells you rather than guessing silently: _"That time does not exist on that date — the clocks go forward."_ And on the way back: _"That time happens twice on that date."_

### Two safety nets you should know about

**Bookings that fall outside the new schedule.** If you shorten a week that already has appointments in it, saving does not fail — it stops and shows you exactly which appointments now sit outside the hours:

> _These appointments still stand and still hold their slot. Saving does not cancel or move them — it only means the schedule no longer covers them._
> _Nobody is emailed about this. If an appointment needs to move or be cancelled, do that from the Bookings screen._

Press **Save anyway** to go ahead, or **Go back** to rethink. It warns rather than refuses, because the alternative — refusing to let you change your hours — would force you to cancel real customers just to edit a schedule.

**Somebody else editing the same diary.** If a provider and their assistant open the same week at once, the second one to save is told:

> _{name} saved this schedule {when}, while you were editing it. Nothing you typed has been saved._

Nothing is silently overwritten. **Reload their version** replaces what's on screen — so copy anything you still need first. The screen also shows a quiet line at the top telling you who last changed this schedule and when.

---

## Giving your team logins

There are three ways somebody gets access, and each one is in the place that knows what that person needs.

| Who                                | Where you invite them                                              | What the invitation carries         |
| ---------------------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| **A provider**                     | Providers → their row → **Invite**                                 | Their own diary                     |
| **Front desk / assistant**         | A provider's Availability → **Delegates** → **Invite someone new** | The diaries they will cover         |
| **Another owner or administrator** | Overview → **Invite an owner or administrator**                    | No diary — they manage the business |

Every invitation is a **single-use link sent by email**; the person chooses their own password — we never send one.

### Inviting a provider

**Providers screen → the provider's row → Invite.** The invitation **carries their diary with it**. Once they accept:

> _This diary becomes theirs: they can set their working hours, add time off, and see their own bookings._

A provider without an email address on file can't be invited; add one to their record first. If there's already a live invitation outstanding, the screen warns you that sending another will stop the first link working. If the email never arrives, **Show the link instead** gives you the link once to pass on yourself.

### When the owner also treats patients

Plenty of owners are practitioners too. You don't need a second account or a second role: create yourself as a provider on the Providers screen, then on **Overview → Members**, in your own row, choose **Also treats patients? Link a diary…** You stay the owner, with your own diary alongside — reached, like everybody else's, from your row on the Providers screen. **Unlink diary** undoes it; the diary and its bookings stay.

One rule here is firm: **somebody who owns a business on the platform cannot work as a provider at a different business, and vice versa.** If an invitation would break that, accepting it is refused with an explanation — use a separate account for the other business.

---

## Who can do what

Four roles. Each belongs to a **membership** — that is, to a person _in one particular business_. The same person can be an administrator at one clinic and an assistant at another, with completely different powers in each.

|                                                 | Owner | Administrator | Provider | Assistant |
| ----------------------------------------------- | :---: | :-----------: | :------: | :-------: |
| Billing and subscription                        |  ✅   |       —       |    —     |     —     |
| Business settings, contact details and policies |  ✅   |       —       |    —     |     —     |
| Invite and manage members                       |  ✅   |      ✅       |    —     |     —     |
| Services, locations, providers                  |  ✅   |      ✅       |    —     |     —     |
| AI receptionist: settings, profile and FAQs     |  ✅   |      ✅       |    —     |     —     |
| AI receptionist: read conversations             |  ✅   |      ✅       |    —     |     —     |
| Edit **anyone's** working hours                 |  ✅   |      ✅       |    —     |     —     |
| Edit **their own** working hours                |  ✅   |      ✅       |    ✅    |     —     |
| Edit a **delegated** diary's hours              |   —   |       —       |    —     |    ✅     |
| See and manage **all** bookings                 |  ✅   |      ✅       |    —     |     —     |
| See and manage **their own** bookings           |  ✅   |      ✅       |    ✅    |     —     |
| See and manage **delegated** bookings           |   —   |       —       |    —     |    ✅     |
| **Decide who assists on a diary**               |  ✅   |       —       |    —     |     —     |

Two lines in that table are worth pausing on.

**An administrator can edit every schedule in the clinic and still cannot decide who assists on a diary.** That gap is intentional. Editing a diary is a day's work; handing somebody else the keys to it is a staffing decision, and staffing is the owner's.

**An assistant reaches the diaries they have been given, and no others.** Not "all bookings" — the specific diaries somebody handed them. Until they've been given one, their Bookings screen is empty, and the sidebar won't even show it. That isn't a bug; it's the front desk having exactly the access it was granted.

> **Your sidebar shows only what you can actually use.** Screens you have no permission for aren't listed, and screens that would be empty — Bookings with no diary, Availability with no diary of your own — aren't listed either. A provider sees three items; an owner sees them all. If somebody says a screen is "missing", it's usually a diary that hasn't been assigned yet.

---

## Sharing a diary — delegation

Your front desk needs to see the diaries they cover, and only those. That's what delegation does.

**Only the owner can do this.** Open a provider's **Availability** screen and switch to the **Delegates** tab.

> _People who assist on this diary. You choose who, and what each of them may do._

Press **Add a delegate**, choose a member, and tick what they may do:

| Scope            | What it gives them                                           |
| ---------------- | ------------------------------------------------------------ |
| **Availability** | Set working hours and book out time off on this diary        |
| **Bookings**     | See, accept, reschedule and cancel this diary's appointments |

Tick one or both — a delegate needs at least one. To remove access entirely, use **Revoke**; they lose it on their next action.

### Inviting somebody who has no account yet

You don't need a two-step dance. Press **Invite someone new**, enter an email address, and the invitation carries the diary assignment with it. When they accept, they get their membership and their diary in the same moment — so they never land on an empty dashboard wondering what went wrong.

One address can hold **one live invitation per business** at a time. Invite the same person for a second diary and the newer invitation supersedes the first.

**One assistant can hold several diaries**, which is exactly what a front desk covering four providers needs.

A provider can always see who assists on their own diary — they just can't change it. Their screen says so: _"The organization owner decides who — ask them to change it."_

---

## Your booking page — what customers see

Your page lives at your business's own address and needs no account. `…/your-slug` on its own also works and lands on the booking page — handy for posters and for reading out over the phone. Five steps:

![The When step: a month calendar with dots on bookable days, beside the free times for the selected day](assets/screenshots/en/public-booking-when.png)

```mermaid
flowchart LR
    A[1️⃣ Service<br/>What would you<br/>like to book?] --> B[2️⃣ Who<br/>Someone specific,<br/>or anyone available]
    B --> C[3️⃣ When<br/>Month calendar,<br/>then times]
    C --> D[4️⃣ Details<br/>Name and how<br/>to reach them]
    D --> E[5️⃣ Done<br/>Reference number<br/>and manage link]
```

**Step 1 — Service.** Everything you've marked active, with its duration and price. Services with no price show _"On request"_. A service needing approval is labelled _"confirmed by the clinic"_ so nobody is surprised later.

**Step 2 — Who.** Your bookable providers, plus **"Anyone available"** — which is what most people choose, and which opens up every free slot across your whole team.

**Step 3 — When.** A month calendar. Each day shows how many times are free, so an empty day is visible before it's clicked rather than after. If a month is empty, the page doesn't dead-end — it looks ahead and offers the **next available** day, even if that's months out. Only if there's genuinely nothing does it suggest contacting you directly.

**Step 4 — Details.** Name, email, phone, and anything you should know. Required fields are marked; email or phone is required — at least one way to reach them.

**The chosen time is held while they type.** _"This time is reserved for {time}"_ — about five minutes. It stops two people filling in the same form for the same slot. If the hold runs out they're asked to pick again, and if somebody else confirms first they're told plainly — _"Somebody just took that time"_ — and shown what's still free rather than being dumped back at the start.

**Step 5 — Done.** A reference number and a link to manage the booking. If the service needs approval, this reads _"The clinic will confirm this appointment shortly"_ instead.

> The manage link is the **only** way a customer changes a booking online. It's in their email too — but the page says _"Save this link"_ for a reason. We store only a scrambled version of it, so if it's lost, it cannot be recovered or resent; the appointment has to be changed by your staff instead.

### What the customer can do with that link

Opening it shows their appointment — status, when, where, service, provider, price — and two actions:

- **Change the time.** They propose a new time and the page checks it before committing: _"This appointment can move to {time}."_ If it can't, they're told to call you rather than left guessing.
- **Cancel.** With a clear warning that it frees the time for somebody else and cannot be undone.

An appointment that is already cancelled or completed is settled, and the page says so instead of offering buttons that would fail.

---

## What customers receive by email

Five emails, all in the customer's own language:

| Email                 | When                                            | Carries a manage link?             |
| --------------------- | ----------------------------------------------- | ---------------------------------- |
| **Booking requested** | Immediately, for a service that needs approval  | ✅                                 |
| **Booking confirmed** | On confirmation, or when staff accept a request | ✅ (plus _Add to Google Calendar_) |
| **Booking changed**   | When the time moves                             | —                                  |
| **Booking cancelled** | When it's cancelled                             | —                                  |
| **Reminder**          | 24 hours before the appointment                 | —                                  |

The same emails go out whether the customer booked by form or by chat.

The confirmation email carries an **Add to Google Calendar** button. It's a one-tap prefill — it doesn't connect anything to your system, and it's deliberately only on the confirmation: putting it on a reschedule email would add a _second_ entry to somebody's calendar rather than moving the one already there.

Your **cancellation policy**, if you've set one, is printed on the confirmation exactly as you wrote it.

---

## Running the day — the Bookings screen

**Dashboard → Bookings.** This is the screen your team lives in.

![The Bookings screen: date and status filters above a list of appointments, each with customer, provider, reference, price, status and its actions — one awaiting approval](assets/screenshots/en/dashboard-bookings.png)

Filter by **date range**, by **provider** — _"Everyone"_, or _"All my providers"_ if you're an assistant with several diaries — and by **status**.

| Status                | Meaning                                     |
| --------------------- | ------------------------------------------- |
| **Awaiting approval** | A request on a service that needs approving |
| **Confirmed**         | Going ahead                                 |
| **Cancelled**         | Called off                                  |
| **Completed**         | Happened                                    |
| **No-show**           | Didn't turn up                              |
| **Expired**           | A hold that was never completed             |

Four actions sit on each row: **Accept** (turns a request into a confirmed appointment, and emails the customer), **Mark completed**, **Mark no-show**, and **Cancel**. Anything that can't be undone asks you to confirm first.

Watch for the **Outside schedule** badge. It flags an appointment that no longer sits inside the provider's working hours, or that now falls during time off. The appointment is still real and still holds its slot — the badge is telling you a schedule changed underneath it and somebody should decide what to do.

---

## The AI receptionist

_Professional and Professional Plus plans._ Owners and administrators manage it; providers and assistants don't see it.

### What your customers see

A chat at `…/your-slug/chat`, reachable three ways: the **chat QR code** from your Overview screen, a **chat bubble on your own website** (ask us for the snippet to paste), or a plain link.

![The chat page: the customer asks for a consultation next Monday, and the assistant answers with six free times as buttons](assets/screenshots/en/public-chat.png)

The customer presses start and types — or taps one of your services, which the welcome message lists as buttons. The receptionist can:

- answer questions about your **services, prices, providers, locations, opening hours, and booking and cancellation policies**, and your **FAQs**;
- **find free times** and offer them as buttons — one tap picks a time, no retyping;
- **book the appointment**, using exactly the same hold, rules and confirmation emails as the booking form.

Nothing is booked behind the customer's back: before anything is written, the chat shows a summary card and the customer presses **Confirm**. **Use booking form** is visible the whole time, and if the assistant is unavailable — switched off, the month's chats used up, or a technical problem — the chat says so and points to the form, which keeps working.

Chats are short on purpose: each one has a time limit, with a visible countdown and a one-minute warning, and messages have a length limit and must be typed rather than pasted. Changing or cancelling an existing appointment stays with the customer's **manage link**.

The chat speaks **Hungarian, English, German and French** — whichever the customer uses, among the languages you've enabled.

### Switching it on — the AI Assistant screen

**Dashboard → AI Assistant.**

![The AI Assistant screen: monthly usage figures, and the settings with a notice that the live assistant's knowledge has one unresolved error](assets/screenshots/en/dashboard-assistant.png)

- **Settings** — **Enabled**, the **assistant's name** (shown under the chat heading), the **languages** it may speak, and the **message for contacting the company** that it gives when it can't help.
- **Usage** — conversations this month, how many were active and successful, and the AI allowance used.
- **Conversations** — every chat, filterable by date, with its status and the full transcript.

For the chat to actually run, four things must be true at once: it is **enabled**, the **plan includes it**, the AI service is available, and there are **chats left this month**. If any one isn't, customers are sent to the form.

### What it knows — and the one rule behind it

The receptionist reads two kinds of thing:

1. **Your records** — services and prices, providers, locations, working hours, contact details. These are **facts**.
2. **Your texts** — the company profile, service descriptions and FAQs. These **explain** the facts.

**When the two disagree, the records win.** If your profile says you're open on Saturdays but nobody has Saturday hours, the assistant answers from the working hours. If a description mentions a price that isn't set on any service, the assistant won't quote it. A text can explain a fact; it can never add one or overrule one.

That's why the most valuable thing you can do for the assistant is keep your catalogue and working hours right — and keep facts _out_ of the prose.

### Writing its texts — on the Overview screen

On a Professional plan, **Overview** carries everything the assistant reads besides your catalogue:

- **Company profile** — who you are, your specialties, anything useful for a visitor. One per language (Hungarian, English, German, French); a language with no profile falls back to your default language's.
- **Frequently asked questions** — approved answers, each in a chosen language. **Add FAQ** to add one.
- **Contact details and policies** — contact email and phone, booking policy and cancellation policy. The assistant gives these when somebody asks how to reach you or whether they can cancel. _(Owner only.)_

**There's a character allowance per language** — 30,000 characters shared across the company profile, every service description and every FAQ question and answer, archived and inactive ones included. The editors show a running count — _"English content: {used} / 30,000 characters"_. A save that would go over is refused and **your draft is kept**; while you're over, you can still save anything that makes the total smaller.

**Translation drafts.** Next to a profile in another language, **Draft from {language}** fills in a machine translation; for FAQs, **Draft translations** proposes translations of the default language's FAQs that you add one by one. **Nothing is saved until you save it**, and a draft is marked as machine-translated until you edit it.

### The knowledge check

![The knowledge check reporting one error: an FAQ answer gives opening hours that differ from the working hours, with Fix it here and Mark as intended](assets/screenshots/en/dashboard-knowledge.png)

Above the editors sits the **Assistant knowledge check**: a list of every place your texts disagree with your records, each with an **Error** or **Warning** badge, the text it came from, and a **Fix it here** link. It catches, among others:

- a treatment listed as something you offer that **can't be booked**;
- a person named who **isn't a bookable provider**;
- a **city** that isn't where your locations are;
- **opening hours** typed into the text — even correct ones, because they'll go out of date;
- a **price** not set on any service, or the same price kept in two places;
- a **missing language** — no profile, service translations or FAQs for a language the assistant speaks;
- a **customer's name** in a testimonial, which the assistant could repeat to anyone;
- **no contact email or phone** set, or a provider who offers services but has **no working hours**.

Some findings are deliberate — you really do mention a treatment that's planned at a consultation. Press **Mark as intended** and it stops counting. If you later reword that text, the finding comes back, because what you approved was that wording.

> **The assistant can't be switched on while an unresolved error remains.** Fix each one, or mark it as intended. Once it's live, a new error never switches it off — the AI Assistant screen tells you there's something to look at, and customers keep being served.

The check also shows **How to write texts the assistant can use** — eight short rules:

| Rule                    | In one line                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| **Offerings**           | Only list a treatment as offered if it's a bookable service — or say how it's reached      |
| **People**              | Name only bookable providers; name anyone else together with their role                    |
| **Place**               | City and address come from Locations; if you repeat them, they must match                  |
| **Hours**               | Don't write opening hours in the text — they come from working hours                       |
| **Prices**              | A price belongs on the service; the assistant only quotes prices set there                 |
| **One fact, one place** | Something about one service belongs in that service's description, not also in the profile |
| **Languages**           | Every language the assistant speaks should have its own profile, translations and FAQs     |
| **Personal data**       | No customers' names, for example in testimonials                                           |

**Review with AI** goes one step further: it asks the AI to read your texts against your records and point out claims the automatic checks can't understand. It's **advisory** — it never blocks the assistant — and it uses your AI allowance; running it again on unchanged texts is free.

### Reading conversations

Every transcript is on the AI Assistant screen. If an answer **named something your records don't hold** — a treatment, a person, a price — the message is flagged:

> _This answer named something your records do not hold: {values}. The customer saw it as written._

A flag almost always points back to the knowledge check: a text that suggested something the records don't support. Fix the text, and the next customer gets the right answer.

---

## Your staff app — on your phone

There's nothing to download from an app store. booking-and-more installs from the browser onto your home screen, for owners, providers and assistants alike.

- **Install it** from your business's staff page — `…/your-slug/install/staff`, or the staff QR code we provide. Your browser asks you to confirm. On iPhone or iPad: open the page in **Safari**, tap **Share**, then **Add to Home Screen**.
- **It opens your business's own staff sign-in** — _"Staff sign-in · {your business}"_ — and then your workspace. An account that isn't a member of that business is told so, with a button to sign in as somebody else.
- **It needs a connection.** Offline, it shows a notice and a _Try again_ button rather than out-of-date appointments.

Installing is optional — everything works the same in a normal browser.

**Customers never install anything.** The patient QR codes open your booking page or chat directly in their browser.

---

## Languages and time zones

**Two languages for the interface:** Hungarian and English. Each person picks their own from the language switcher — it doesn't change anything for anyone else. Your customers get the booking page and every email in the language your organization was set up with, or the one they switch to.

**Four languages for content:** service names and descriptions, the company profile and FAQs can each be kept in Hungarian, English, German and French, and the AI receptionist chats in all four.

Providers can additionally record the **languages they speak** — Hungarian, English, German or French — to help customers choose.

**On time zones**, two rules keep things sane:

- **Working hours are wall-clock.** "Mondays 09:00–17:00" stays 09:00–17:00 through a daylight-saving change.
- **A specific appointment is a moment in time.** A customer in another country sees it converted to their own clock, correctly, in both directions.

You never have to think about this — but it's why the availability screen tells you which zone you're typing in.

---

## When the booking page shows nothing

The commonest support question, and it almost always has one of a few plain causes. Work down this list:

```mermaid
flowchart TD
    Q([Booking page offers<br/>no times]) --> Sub{Subscription<br/>active?}
    Sub -->|No| FixSub[Subscribe — the catalogue<br/>is locked until then]
    Sub -->|Yes| Svc{Any active<br/>services?}
    Svc -->|No| FixSvc[Add a service,<br/>or activate one]
    Svc -->|Yes| Asg{Provider assigned<br/>to that service?}
    Asg -->|No| FixAsg[Providers then Assign]
    Asg -->|Yes| Onl{Provider active and<br/>bookable online?}
    Onl -->|No| FixOnl[Turn on 'Bookable online',<br/>or restore an archived provider]
    Onl -->|Yes| Hrs{Working hours<br/>set?}
    Hrs -->|No| FixHrs[Provider sets their<br/>weekly hours]
    Hrs -->|Yes| Win{Notice window<br/>too tight?}
    Win -->|Yes| FixWin[Check minimum notice<br/>and days ahead]
    Win -->|No| Buf[Check the periods are long<br/>enough for the service<br/>plus its buffers]
```

The two that catch people out most:

**A provider with hours but no assigned service.** Their diary looks perfectly configured and they cannot be booked, because a booking is always _for a service_. Fix it with **Assign** on their row. The Availability screen now warns about this as soon as you open it.

**Working periods shorter than the service plus its buffers.** A 30-minute service with 10 minutes of buffer each side needs a 50-minute window. A 09:00–09:45 period looks generous and fits nothing.

If a service's **book up to (days ahead)** is set very low, the screen warns you at the time — _"Only the next {n} days will be bookable"_ — because it's an easy setting to mistype.

The AI receptionist offers exactly the times the booking page does, so if the page shows nothing, so will the chat — fix it here and both recover.

---

## A sensible order to set everything up

1. **Accept your invitation** and choose a password.
2. **Subscribe** — pick a plan, follow the emailed payment link, start the trial.
3. **Add your services** — duration, buffers, price, and whether each needs approval.
4. **Add your locations** — skip entirely if you only work online or by phone.
5. **Add your providers**, and **Assign** each one their services. Don't skip this. If you treat patients yourself, add yourself too and link your diary on Overview.
6. **Invite your providers** from their rows, so each invitation carries its diary.
7. **Each provider sets their working hours** on the Availability screen.
8. **Invite your front desk** from the Delegates tab of the diaries they'll cover.
9. **Open your booking page yourself** and book a test appointment end to end.
10. **On a Professional plan:** fill in contact details, company profile and FAQs on Overview, clear the knowledge check, then switch the assistant on and have a test chat.
11. **Share the links** — download the QR codes, put them on your website and your door, and add the chat bubble to your site.

---

## Good habits

- **Archive, don't recreate.** If a name is refused, tick _Show archived_ and restore instead — it keeps your appointment history correct.
- **Put buffers on the service, not in the duration.** The customer should see the honest length of their appointment; the cleanup time is yours.
- **Let providers own their hours.** They're the ones who know when they're away, and the screen is built for them.
- **Delegate narrowly.** Give the front desk _Bookings_ on the diaries they cover. Add _Availability_ only where they genuinely manage somebody's schedule.
- **Check the Outside schedule badge** after any schedule change. It's the one thing that won't email anybody.
- **Keep facts in records, not in prose.** Hours in working hours, prices on services, addresses on locations. The assistant trusts the records, and your texts can't go out of date if they don't repeat them.
- **Read a few transcripts each week.** A flagged answer is a five-minute fix to a text that would otherwise mislead the next customer too.
- **Test with a real booking** — and on a Professional plan, a real chat — before you share the link. Five minutes, and it catches everything above.
