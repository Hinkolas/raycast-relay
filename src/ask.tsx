import { Action, ActionPanel, Icon, List, type LaunchProps } from "@raycast/api";
import { useState } from "react";
import { AnswerView } from "./components/AnswerView";

export default function AskQuestion(props: LaunchProps<{ arguments: Arguments.Ask }>) {
  // When used as a fallback command, the root search text arrives as `fallbackText`.
  const initialQuestion = (props.arguments?.question || props.fallbackText || "").trim();
  const [question, setQuestion] = useState(initialQuestion);
  const [round, setRound] = useState(0);

  if (!question) {
    return (
      <QuestionInput
        onSubmit={(next) => {
          setQuestion(next);
          setRound((current) => current + 1);
        }}
      />
    );
  }
  return <AnswerView key={round} question={question} onAskAnother={() => setQuestion("")} />;
}

function QuestionInput({ onSubmit }: { onSubmit: (question: string) => void }) {
  const [text, setText] = useState("");
  const question = text.trim();

  return (
    <List
      navigationTitle="Ask Question"
      searchBarPlaceholder="Ask a question…"
      searchText={text}
      onSearchTextChange={setText}
      filtering={false}
    >
      <List.EmptyView
        icon={Icon.QuestionMarkCircle}
        title={question ? "Press ↵ to Ask" : "Ask a Quick Question"}
        description="Get one answer without starting a chat. Tip: add Ask Question as a fallback command to ask straight from Raycast's root search."
        actions={
          question ? (
            <ActionPanel>
              <Action title="Ask" icon={Icon.ArrowRight} onAction={() => onSubmit(question)} />
            </ActionPanel>
          ) : undefined
        }
      />
    </List>
  );
}
