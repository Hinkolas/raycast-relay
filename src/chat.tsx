import { ChatView } from "./components/ChatView";
import { useChat } from "./hooks/useChat";

export default function QuickChat() {
  const chat = useChat({ persist: true });
  return <ChatView chat={chat} />;
}
