# Employee privacy notice draft: companyOS Twin (company deployment)

> **DRAFT. Not legal advice. For review by qualified counsel before any use.**
>
> Draft v0.1, 2026-10-31. Template built from [`docs/research/privacy-legal.md`](../research/privacy-legal.md) and [`docs/plan/README.md`](../plan/README.md) (§3, §5, §8, §13). No lawyer has reviewed it.
>
> **Note to the company, not for employees.** Before issue, resolve every **[SQUARE BRACKET]** and every **CONFIRM** item. Check every product statement against the build deployed. Remove this box and the bracketed notes before issue. Translations (German, French and others as needed) must be prepared by qualified translators and checked by counsel. Open items are in [`dpia-outline.md`](dpia-outline.md) section 8 (OI-n).

---

## Your privacy and the companyOS Twin app

**Who we are.** [COMPANY NAME], [REGISTERED ADDRESS], is responsible for how [PRODUCT NAME] (working name: companyOS Twin) is used on work devices in [JURISDICTION AND SITE]. [CONFIRM the controller role, and whether [VENDOR NAME] is a processor or has no access to personal data.]

**Privacy contact.** [NAME, EMAIL]. [DATA PROTECTION OFFICER CONTACT, if appointed.]

### What the app is

[PRODUCT NAME] watches how you use your computer so that it can learn your repeated tasks, suggest shortcuts and, if you choose, run them for you. Information about you is kept on your device, encrypted, and you control it. [CONFIRM against the build deployed.]

### Is it compulsory?

Your personal assistant is optional. You can decline it or turn it off. Declining has no effect on your job, pay, reviews or career. [COMPANY AND COUNSEL: state whether any part of the software is installed on all work devices. If so, explain why, state its legal basis, and give it its own notice.]

### What the app records on your device

- The names of the apps you use, and a category for each window. [CONFIRM whether window titles are recorded. OI-1.]
- When browser capture is on: the website domain of the active tab. It does not record the full address, the page's text or query strings. Private and incognito windows are never recorded. [CONFIRM. OI-1.]
- Whether your computer is idle or locked.
- [CONFIRM: counts of keys pressed and keyboard shortcuts, without the keys themselves. OI-2.]
- Screen content, only if you choose to turn on screen understanding. [CONFIRM: opt-in by design.] Text read from the screen is handled in memory, redacted and then discarded. Screenshots are not saved.

**What is never recorded:** what you type, passwords and other secure fields, clipboard contents, the content of pages, webcam, microphone or meeting audio, and anything in an app you have excluded. [CONFIRM each item against the build deployed.]

### Why this is used

1. **For you:** to find your repeated tasks, suggest automations, and run the ones you approve.
2. **For [COMPANY NAME]:** to see which workflows and apps are used across groups, in statistics that cannot show what any one person did. Statistics are shown only for groups of at least [10] people. [COMPANY: state the specific business purpose. Counsel to test it.]

**We do not use the app to:**
- rate, rank or score you;
- measure your productivity, your idle time or how busy you appear;
- infer your mood, stress, focus or engagement;
- make decisions about your job, pay, promotion or discipline;
- monitor you on personal devices, outside working hours or at home. [CONFIRM for each jurisdiction.]

### Legal basis

- **Personal assistant:** your consent. You can withdraw it at any time without penalty. [COUNSEL: confirm.]
- **Company statistics:** the legitimate interests of [COMPANY NAME] in [PURPOSE], assessed in [LEGITIMATE-INTERESTS ASSESSMENT REFERENCE], together with the works agreement [TITLE AND DATE]. [COUNSEL: confirm.]

### Who receives what

- **You:** all of your data, on your device.
- **[COMPANY NAME]:** only statistics about workflows and apps. Never data about an individual.
- **[VENDOR NAME]:** [CONFIRM: no identifiable data. List any telemetry the vendor receives, and whether it needs your consent.]
- **Published automations:** if you choose to publish an automation to the company library, you see a preview with personal details removed before anything is sent. You choose whether your name is attached.
- **Delegated tasks:** if you choose to send a task to [DELEGATION PARTNER, if enabled], only the task brief, the routine name, the app sequence and the usual timing are sent, and only after you press send. Your activity history, screenshots and window contents are not sent. [CONFIRM whether this is available in the company deployment.]
- **Model downloads:** when you install an AI model, your device connects to [HOST NAMES]. Those hosts see your IP address, but no information about your activity.

### How it is protected

Your data is encrypted on your device. The encryption key is kept in your device's secure storage. [CONFIRM that neither the company nor the vendor holds a copy of the key. A legal hold could require a change to this. OI-7.]

### How long it is kept

| Data | Period |
|---|---|
| Raw activity events | [X DAYS]. [DECIDE: research recommends 7 to 14 days. The shipped MVP keeps 90 days.] |
| Patterns and suggestions | [X DAYS] |
| Automations and routines | Until you delete them |
| Company statistics | [PERIOD, set by counsel] |

You can delete everything at any time. Deleting removes your data and its encryption key, so it cannot be recovered.

### Your rights

You can ask for access to your data, correction, erasure, restriction, and a copy in a portable format. You can object to processing, and you can withdraw consent to the personal assistant at any time.

Because [COMPANY NAME] does not hold individual data, most of these requests are carried out on your device. You can export or delete your twin there. For other requests, contact [PRIVACY CONTACT]. [COUNSEL: state how the company responds to a request it cannot fulfil itself.]

You can complain to [SUPERVISORY AUTHORITY, COUNTRY].

### Your controls

- Pause the app at any time.
- Exclude apps and websites.
- See when the app is running. [CONFIRM: visible capture indicator and tray switch.]
- See a log of outbound connections.
- Choose the autonomy level for each automation.

Your employer can switch the app off remotely, as a safety brake. It cannot turn on capture, reduce your exclusions or disable your pause. [CONFIRM against the admin controls matrix, plan §8.1.]

### Information about other people

The app may capture information about colleagues or customers who appear on your screen. Identifiers are removed before anything is stored. [CONFIRM.] Do not use the app to record other people, and exclude any app that holds information about other people.

### Automated decisions

The app does not make decisions about you. It takes an action only when you have approved it, within the autonomy level you have chosen. [CONFIRM for every autonomous action.]

### Changes to this notice

Version [X], [DATE]. [COUNSEL: state how employees are told about a change that affects how their data is used.]

---

## Items to resolve before issue (remove before issue)

1. **OI-1:** window and page titles. Decide whether they are recorded, and make the text match.
2. **OI-2:** keystroke counts and shortcut chords. Decide whether they are included.
3. **Retention:** set the periods in the table above.
4. **Roles:** confirm controller, processor and joint-controller status.
5. **Lawful basis:** confirm the basis for each purpose. The legitimate-interests assessment is not yet drafted.
6. **Legal hold:** confirm the position on key custody (OI-7).
7. **Jurisdiction-specific notices:** these are separate documents and are not drafted here. They include the New York notice under Civil Rights Law §52-c, the Connecticut and Delaware notices, the AI Act Art. 26(7) information, a CCPA notice at collection for California employees if applicable, and any UK notice (privacy-legal §3, §7).
8. **Translations:** prepare them with qualified translators, and check them with counsel.
9. **Verify:** check every CONFIRM item against the shipped build, not the design target.
