# No mid-Session Clear

The Client cannot retract Text without ending the Session. JoyAI's webinfer has no clear-query API — empty text keeps the last question, and reset wipes the whole streaming session. An explicit Clear that reset webinfer would surprise the user (memory and Frame history gone) while looking like a small edit. Hang up and Start again.
