import type { LaunchProps } from "@raycast/api";
import { useEffect, useRef } from "react";
import { ChatView } from "./components/ChatView";
import { useChat } from "./hooks/useChat";

export default function QuickChat(props: LaunchProps<{ arguments: Arguments.Chat }>) {
  const chat = useChat({ persist: true });
  const firstMessage = (props.arguments?.message || props.fallbackText || "").trim();
  const sent = useRef(false);

  useEffect(() => {
    if (!firstMessage || sent.current) return;
    sent.current = true;
    chat.send(firstMessage);
  }, []);

  return <ChatView chat={chat} />;
}
