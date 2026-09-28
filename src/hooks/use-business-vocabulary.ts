import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { vocabularyFor, type BusinessVocabulary } from "@/lib/business-vocabulary";

export function useBusinessVocabulary(salonId: string | null): BusinessVocabulary {
  const [vocabulary, setVocabulary] = useState(() => vocabularyFor(null));

  useEffect(() => {
    let active = true;
    if (!salonId) {
      setVocabulary(vocabularyFor(null));
      return;
    }
    supabase
      .from("salon_ai_assistant")
      .select("industry")
      .eq("salon_id", salonId)
      .maybeSingle()
      .then(({ data }) => {
        if (active) setVocabulary(vocabularyFor(data?.industry));
      });
    return () => {
      active = false;
    };
  }, [salonId]);

  return vocabulary;
}

