"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface UserPreferences {
  auto_generate: boolean;
  auto_draft: boolean;
  show_urgency: boolean;
}

const DEFAULTS: UserPreferences = {
  auto_generate: true,
  auto_draft: true,
  show_urgency: true,
};

export function usePreferences() {
  const queryClient = useQueryClient();

  const { data: raw } = useQuery({
    queryKey: ["user-preferences"],
    queryFn: () => api.settings.getPreferences(),
    staleTime: 60_000,
  });

  const prefs: UserPreferences = {
    auto_generate: (raw as Record<string, unknown>)?.auto_generate as boolean ?? DEFAULTS.auto_generate,
    auto_draft: (raw as Record<string, unknown>)?.auto_draft as boolean ?? DEFAULTS.auto_draft,
    show_urgency: (raw as Record<string, unknown>)?.show_urgency as boolean ?? DEFAULTS.show_urgency,
  };

  const mutation = useMutation({
    mutationFn: (update: Partial<UserPreferences>) =>
      api.settings.updatePreferences(update),
    onMutate: async (update) => {
      // Optimistic update
      await queryClient.cancelQueries({ queryKey: ["user-preferences"] });
      const prev = queryClient.getQueryData(["user-preferences"]);
      queryClient.setQueryData(["user-preferences"], (old: Record<string, unknown> | undefined) => ({
        ...(old ?? {}),
        ...update,
      }));
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(["user-preferences"], context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["user-preferences"] });
    },
  });

  const updatePreference = <K extends keyof UserPreferences>(
    key: K,
    value: UserPreferences[K]
  ) => {
    mutation.mutate({ [key]: value });
  };

  return { prefs, updatePreference };
}
