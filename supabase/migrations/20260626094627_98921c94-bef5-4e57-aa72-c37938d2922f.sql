ALTER TABLE public.wa_conversations
  ADD COLUMN IF NOT EXISTS selected_branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS wa_conversations_selected_branch_idx
  ON public.wa_conversations(selected_branch_id);

ALTER TABLE public.wa_messages
  ADD COLUMN IF NOT EXISTS meta jsonb;