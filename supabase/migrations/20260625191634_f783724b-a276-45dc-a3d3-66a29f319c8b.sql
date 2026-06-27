
CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_green_id_uniq
  ON public.wa_messages (salon_id, green_api_message_id)
  WHERE green_api_message_id IS NOT NULL;
