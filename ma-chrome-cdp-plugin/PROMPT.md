## ChromeCDP or Fetch

Use Fetch for a stateless one shot read of a public URL. Use `ChromeCDP` when you need the logged-in session. Use it also for a click inside a live page or for a multi step flow. Use it when you need the tabs that the user already has open.

Do not close the last open tab when the connection must stay open. Usually, a script cannot get through a bot check. Ask the user to log in once.

The `events` action shows nothing until you enable the domain. Send a `*.enable` method first, for example `Network.enable`.
