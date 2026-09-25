# Integrations

Things that talk to Breeze from outside.

## Bitfocus Companion

The Companion connection module — actions for every control verb, feedbacks that
colour a button from live playback state, presets built from the server's channel
list, and variables — lives in its own repository under the Bitfocus organisation:

**<https://github.com/bitfocus/companion-module-breeze-overlay>**

It talks to Breeze over the public HTTP API only, so it versions independently of
this repository. It is MIT-licensed, not MPL-2.0: Bitfocus requires MIT (or GPL)
for a module to be listed in and bundled with Companion.

Operator documentation — configuration, actions, nested compositions, and what to
check when a button does nothing — is the module's `companion/HELP.md`, which
Companion shows under the connection's Help button.
