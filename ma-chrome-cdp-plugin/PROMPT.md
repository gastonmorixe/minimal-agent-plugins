## ChromeCDP or Fetch

Use Fetch for a stateless one shot read of a public URL. Use `ChromeCDP` when you need the logged-in session, a click inside a live page, a multi step flow, or the tabs the user already has open.

Do not close the last open tab when the connection must survive. A bot check usually cannot be scripted, so ask the user to log in once.

The `events` action shows nothing until you enable the domain. Send a `*.enable` method first, for example `Network.enable`.
