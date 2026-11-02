import { isSystemProcess, normalizeAppName } from '../classify';

/**
 * Says once, for each application, that it has been seen for the first time, so a discovery can run when someone opens
 * an app the twin has not met. The seen names are kept by the caller, so they survive a restart. System processes never
 * count, and a name is compared in its normalised form, so "Slack" and "slack.app" are one application.
 */
export class FirstSeen {
  private readonly seen: Set<string>;

  constructor(seen: Iterable<string> = []) {
    this.seen = new Set([...seen].map(normalizeAppName));
  }

  /** True only the first time an application is seen. Repeats and system processes return false. */
  observe(app: string): boolean {
    if (!app.trim() || isSystemProcess(app)) return false;
    const key = normalizeAppName(app);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /** Every application seen so far, in normalised form, so the caller can save them. */
  names(): string[] {
    return [...this.seen];
  }
}
