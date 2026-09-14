# Standing query is a Model behavior, not a Feed rule

JoyAI's webinfer session persists the last non-empty user text (`current_query_text`); empty text does not clear it. The playground does not own a Session-wide Query or Text queue. Ingest immediately offers Text to the adapter, but offering it is not a separate upstream request.

JoyAI and Mock retain the latest non-empty stripped Text locally. JoyAI sends it with the next visual turn; Mock uses it in the next media-triggered turn. Text alone does not wake the feeder or initiate a turn. Snapshot Text before awaiting HTTP or simulated latency so updates cannot change a turn already in flight. Empty Text leaves it unchanged; ending the Session clears it. Other Models need not inherit this behavior.
