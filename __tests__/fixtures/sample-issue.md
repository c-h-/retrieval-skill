---
id: abc123
identifier: ENG-1234
title: Fix auth token refresh in middleware
state: In Progress
team: Engineering
creator: charlie
createdAt: 2025-01-15T10:00:00.000Z
---

# ENG-1234: Fix auth token refresh in middleware

## Description

The auth token refresh was failing because the middleware was not properly handling the case where the refresh token had expired. This caused users to be logged out unexpectedly.

## Steps to Reproduce

1. Log in to the application
2. Wait for the access token to expire (1 hour)
3. Try to make an API call
4. The request fails with a 401 error instead of refreshing the token

## Expected Behavior

The middleware should automatically detect the expired access token, use the refresh token to obtain a new access token, and retry the original request transparently.

## Comments

### Charlie - 2025-01-15

I think the issue is in the `authMiddleware.ts` file. The refresh logic checks for token expiry but doesn't handle the race condition where multiple requests hit the refresh endpoint simultaneously.

### Sarah - 2025-01-16

Confirmed. I added a mutex lock around the refresh call and it fixed the issue. PR incoming.

### Charlie - 2025-01-17

Great catch Sarah! The mutex approach is the right pattern. Let's also add a retry queue for requests that arrive during the refresh window.
