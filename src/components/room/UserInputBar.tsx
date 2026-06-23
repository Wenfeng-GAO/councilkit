import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { useState } from "react";

interface UserInputBarProps {
  disabled?: boolean;
  onSubmit: (text: string) => void;
}

export function UserInputBar({ disabled, onSubmit }: UserInputBarProps) {
  const [text, setText] = useState("");
  return (
    <form
      className="mx-auto flex max-w-3xl gap-2 px-6 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim().length === 0) return;
        onSubmit(text.trim());
        setText("");
      }}
    >
      <TextInput
        className="flex-1"
        placeholder="以参与者身份发言或追问…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="用户发言"
      />
      <Button type="submit" disabled={disabled}>
        发送
      </Button>
    </form>
  );
}
