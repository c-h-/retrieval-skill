---
thread_ts: "1740599144.939919"
channel: engineering
channel_id: C08AQ8D9ZEW
started_by: Charlie
participants:
  - Charlie
  - Sarah
  - Mike
reply_count: 3
started_at: 2025-02-26T19:45:44.939Z
---

# Thread in #engineering

**Charlie** (2025-02-26 19:45):
Hey team, we need to discuss the OAuth refresh token handling. The current implementation has a race condition that causes intermittent logouts.

**Sarah** (2025-02-26 19:48):
I noticed that too! When multiple API calls happen at the same time and the token is expired, they all try to refresh simultaneously. We should add a mutex or token refresh queue.

**Mike** (2025-02-26 19:52):
I've seen this pattern before. The standard approach is to have a single promise that all concurrent refresh attempts await. That way only one actual refresh happens.

**Charlie** (2025-02-26 19:55):
Perfect, let's go with Mike's approach. Sarah, can you take the lead on implementing this? I'll create the Linear issue.
