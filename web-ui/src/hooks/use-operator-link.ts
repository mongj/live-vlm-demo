"use client";

import { createOperatorHost, OPERATOR_CHANNEL, type HostState } from "@/lib/operator-channel.mjs";
import { useEffect, useRef, useState, type RefObject } from "react";

const PUBLISH_MS = 500;
const FRAME_WIDTH = 480;
const FRAME_QUALITY = 0.6;

function captureFrame(video:HTMLVideoElement|null, canvas:HTMLCanvasElement):string|null {
  if (!video || video.readyState < 2 || !video.videoWidth) return null;
  const width=Math.min(FRAME_WIDTH,video.videoWidth);
  const height=Math.round(video.videoHeight*width/video.videoWidth);
  if (canvas.width !== width) canvas.width=width;
  if (canvas.height !== height) canvas.height=height;
  try {
    canvas.getContext("2d")?.drawImage(video,0,0,width,height);
    return canvas.toDataURL("image/jpeg",FRAME_QUALITY);
  }
  catch { return null; }
}

/** App window side of the operator window. Returns true while one is open. */
export function useOperatorLink({enabled,state,onSend,onVoice,videoRef}:{
  enabled:boolean;
  state:HostState;
  onSend:(text:string)=>boolean;
  onVoice:(enabled:boolean)=>void;
  videoRef:RefObject<HTMLVideoElement|null>;
}):boolean {
  const [linked,setLinked]=useState(false);
  const latestRef=useRef({state,onSend,onVoice});
  useEffect(()=>{ latestRef.current={state,onSend,onVoice}; });
  useEffect(()=>{
    if (!enabled || typeof BroadcastChannel === "undefined") return;
    const channel=new BroadcastChannel(OPERATOR_CHANNEL);
    const canvas=document.createElement("canvas");
    const host=createOperatorHost({channel,hostId:crypto.randomUUID(),now:()=>Date.now(),
      onSend:text=>latestRef.current.onSend(text),
      onVoice:next=>latestRef.current.onVoice(next)});
    const timer=window.setInterval(()=>{
      const connected=host.connected();
      setLinked(connected);
      host.publish(latestRef.current.state);
      if (!connected) return;
      const frame=captureFrame(videoRef.current,canvas);
      if (frame) host.publishFrame(frame);
    },PUBLISH_MS);
    return ()=>{
      window.clearInterval(timer);
      host.close();
      channel.close();
      setLinked(false);
    };
  },[enabled,videoRef]);
  return enabled && linked;
}
