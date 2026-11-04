"use client";

import { OperatorPanel } from "@/components/operator-panel";
import { createOperatorClient, OPERATOR_CHANNEL } from "@/lib/operator-channel.mjs";
import { useEffect, useRef, useState } from "react";

const BEAT_MS = 1000;

/** Second window for the person typing Wizard of Oz replies, on the screen the participant cannot see. */
export function OperatorWindow() {
  const clientRef=useRef<ReturnType<typeof createOperatorClient>|null>(null);
  const [view,setView]=useState<ReturnType<ReturnType<typeof createOperatorClient>["view"]>>({state:null,frame:null});
  const [failed,setFailed]=useState<string|null>(null);

  useEffect(()=>{
    if (typeof BroadcastChannel === "undefined") return;
    const channel=new BroadcastChannel(OPERATOR_CHANNEL);
    const client=createOperatorClient({channel,now:()=>Date.now(),
      onChange:()=>setView(client.view()),
      onResult:result=>setFailed(result.ok ? null : result.text)});
    clientRef.current=client;
    client.beat();
    const timer=window.setInterval(()=>client.beat(),BEAT_MS);
    const leave=()=>client.close();
    window.addEventListener("pagehide",leave);
    return ()=>{
      window.removeEventListener("pagehide",leave);
      window.clearInterval(timer);
      leave();
      clientRef.current=null;
      channel.close();
    };
  },[]);

  const {state,frame}=view;
  const live=!!state?.live;
  const current=state && state.currentStep >= 0 ? state.steps[state.currentStep] : undefined;
  const status=!state ? "Waiting for the app window. Select Wizard of Oz there." : live ? "Linked to a live session." : "Linked. Start a session in the app window.";

  return (
    <main className="mx-auto flex h-dvh max-w-xl flex-col gap-3 overflow-y-auto bg-background p-4 text-foreground">
      <header>
        <h1 className="text-base font-semibold">Operator window · Wizard of Oz</h1>
        <p className="text-xs text-muted-foreground" role="status">{status}</p>
        <p className="text-xs text-muted-foreground">The app window hides its operator box while this window is open.</p>
      </header>
      <div className="aspect-video shrink-0 overflow-hidden rounded-lg border bg-muted">
        {frame ? (
          // A data URL from the app window, so there is nothing for the image optimiser to fetch.
          // eslint-disable-next-line @next/next/no-img-element
          <img alt="Current frame from the app window" className="size-full object-contain" src={frame} />
        ) : (
          <p className="flex size-full items-center justify-center text-xs text-muted-foreground">No video frame yet</p>
        )}
      </div>
      {state ? (
        <p className="text-xs tabular-nums">
          Clip {state.clipS === null ? "not playing" : `${state.clipS.toFixed(1)} s`}
          {state.steps.length ? ` · Step estimate ${state.currentStep >= 0 ? `${state.currentStep + 1} of ${state.steps.length}` : "none yet"}` : ""}
          {current ? `: ${current}` : ""}
        </p>
      ) : null}
      <OperatorPanel
        live={live}
        onSend={text=>{
          const sent=clientRef.current?.send(text.trim()) ?? false;
          if (sent) setFailed(null);
          return sent;
        }}
        onVoiceChange={enabled=>clientRef.current?.setVoice(enabled)}
        steps={state?.steps ?? []}
        voice={state?.voice ?? false}
      />
      {failed ? <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs" role="alert">Not sent: {failed}</p> : null}
      <section aria-label="Recent messages">
        <h2 className="mb-1 text-xs font-medium">Recent messages</h2>
        {state?.messages.length ? (
          <ul className="flex flex-col gap-1">
            {state.messages.map((message,index)=>(
              <li className="break-words text-xs" key={`${index}-${message.role}`}>
                <span className="text-muted-foreground">{message.role === "assistant" ? "You" : "Input"}: </span>
                {message.text}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-muted-foreground">Nothing yet</p>}
      </section>
    </main>
  );
}
