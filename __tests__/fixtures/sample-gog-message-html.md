---
id: test-msg-001
threadId: test-thread-html
from: Notifications <notify@service.com>
to: user@example.com
date: Wed, 15 Mar 2024 08:00:00 +0000
subject: Your Weekly Report
labels:
  - CATEGORY_UPDATES
sizeEstimate: 5000
historyId: "12345"
---

<!DOCTYPE html>
<html>
<head><style>body { font-family: Arial; color: #333; } .footer { font-size: 12px; }</style></head>
<body>
<div class="container">
  <h1>Weekly Report</h1>
  <p>Hello User,</p>
  <p>Here is your weekly summary:</p>
  <ul>
    <li>Tasks completed: 15</li>
    <li>Tasks pending: 3</li>
    <li>Hours logged: 42</li>
  </ul>
  <p>Keep up the great work!</p>
  <p>Your overall productivity score is <b>92%</b>, which is above the team average of 85%.</p>
  <!-- tracking pixel -->
  <img src="https://example.com/track.gif" width="1" height="1">
  <div class="footer">
    <p>&copy; 2024 Service Inc. &bull; <a href="https://example.com/unsubscribe">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>
