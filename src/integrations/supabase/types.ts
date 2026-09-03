export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_service_overrides: {
        Row: {
          created_at: string
          id: string
          is_enabled: boolean
          salon_id: string
          service_id: string
          sort_order: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_enabled?: boolean
          salon_id: string
          service_id: string
          sort_order?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_enabled?: boolean
          salon_id?: string
          service_id?: string
          sort_order?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_service_overrides_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_service_overrides_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_service_overrides_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      appointment_addons: {
        Row: {
          addon_id: string | null
          appointment_id: string
          created_at: string
          duration_snapshot: number
          id: string
          name_snapshot: string
          price_snapshot: number
        }
        Insert: {
          addon_id?: string | null
          appointment_id: string
          created_at?: string
          duration_snapshot?: number
          id?: string
          name_snapshot: string
          price_snapshot?: number
        }
        Update: {
          addon_id?: string | null
          appointment_id?: string
          created_at?: string
          duration_snapshot?: number
          id?: string
          name_snapshot?: string
          price_snapshot?: number
        }
        Relationships: [
          {
            foreignKeyName: "appointment_addons_addon_id_fkey"
            columns: ["addon_id"]
            isOneToOne: false
            referencedRelation: "service_addons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_addons_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
        ]
      }
      appointment_archives: {
        Row: {
          appointment_count: number
          archived_at: string
          created_at: string
          data: Json
          id: string
          period_end: string | null
          period_start: string | null
          salon_id: string
        }
        Insert: {
          appointment_count?: number
          archived_at?: string
          created_at?: string
          data: Json
          id?: string
          period_end?: string | null
          period_start?: string | null
          salon_id: string
        }
        Update: {
          appointment_count?: number
          archived_at?: string
          created_at?: string
          data?: Json
          id?: string
          period_end?: string | null
          period_start?: string | null
          salon_id?: string
        }
        Relationships: []
      }
      appointment_audit: {
        Row: {
          action: string
          actor_id: string | null
          actor_kind: string
          appointment_id: string
          created_at: string
          detail: Json
          id: string
          salon_id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_kind: string
          appointment_id: string
          created_at?: string
          detail?: Json
          id?: string
          salon_id: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_kind?: string
          appointment_id?: string
          created_at?: string
          detail?: Json
          id?: string
          salon_id?: string
        }
        Relationships: []
      }
      appointment_import_batches: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          rolled_back_at: string | null
          salon_id: string
          source_label: string
          stats: Json
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          rolled_back_at?: string | null
          salon_id: string
          source_label: string
          stats?: Json
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          rolled_back_at?: string | null
          salon_id?: string
          source_label?: string
          stats?: Json
        }
        Relationships: [
          {
            foreignKeyName: "appointment_import_batches_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_import_batches_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      appointment_prepayments: {
        Row: {
          appointment_id: string
          bank: string | null
          confidence: number | null
          created_at: string
          currency: string
          expected_amount: number
          extracted: Json | null
          file_phash: string | null
          file_sha256: string | null
          hold_expires_at: string
          id: string
          receipt_bytes: number | null
          receipt_mime: string | null
          receipt_path: string | null
          refund_note: string | null
          refund_status: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          salon_id: string
          status: string
          txn_id: string | null
          updated_at: string
          verdict: string | null
          verdict_reasons: string[] | null
        }
        Insert: {
          appointment_id: string
          bank?: string | null
          confidence?: number | null
          created_at?: string
          currency?: string
          expected_amount: number
          extracted?: Json | null
          file_phash?: string | null
          file_sha256?: string | null
          hold_expires_at: string
          id?: string
          receipt_bytes?: number | null
          receipt_mime?: string | null
          receipt_path?: string | null
          refund_note?: string | null
          refund_status?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          salon_id: string
          status?: string
          txn_id?: string | null
          updated_at?: string
          verdict?: string | null
          verdict_reasons?: string[] | null
        }
        Update: {
          appointment_id?: string
          bank?: string | null
          confidence?: number | null
          created_at?: string
          currency?: string
          expected_amount?: number
          extracted?: Json | null
          file_phash?: string | null
          file_sha256?: string | null
          hold_expires_at?: string
          id?: string
          receipt_bytes?: number | null
          receipt_mime?: string | null
          receipt_path?: string | null
          refund_note?: string | null
          refund_status?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          salon_id?: string
          status?: string
          txn_id?: string | null
          updated_at?: string
          verdict?: string | null
          verdict_reasons?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "appointment_prepayments_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: true
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_prepayments_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_prepayments_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          branch_id: string | null
          client_name: string
          client_notes: string | null
          client_phone: string
          confirmation_at: string | null
          confirmation_detail: string | null
          confirmation_message_id: string | null
          confirmation_status: string
          created_at: string
          deleted_at: string | null
          ends_at: string
          hold_expires_at: string | null
          id: string
          import_batch_id: string | null
          import_key: string | null
          manage_token: string
          master_id: string
          price: number
          reminder_sent: boolean
          salon_id: string
          service_id: string
          source: string
          starts_at: string
          status: Database["public"]["Enums"]["appointment_status"]
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          client_name: string
          client_notes?: string | null
          client_phone: string
          confirmation_at?: string | null
          confirmation_detail?: string | null
          confirmation_message_id?: string | null
          confirmation_status?: string
          created_at?: string
          deleted_at?: string | null
          ends_at: string
          hold_expires_at?: string | null
          id?: string
          import_batch_id?: string | null
          import_key?: string | null
          manage_token?: string
          master_id: string
          price?: number
          reminder_sent?: boolean
          salon_id: string
          service_id: string
          source?: string
          starts_at: string
          status?: Database["public"]["Enums"]["appointment_status"]
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          client_name?: string
          client_notes?: string | null
          client_phone?: string
          confirmation_at?: string | null
          confirmation_detail?: string | null
          confirmation_message_id?: string | null
          confirmation_status?: string
          created_at?: string
          deleted_at?: string | null
          ends_at?: string
          hold_expires_at?: string | null
          id?: string
          import_batch_id?: string | null
          import_key?: string | null
          manage_token?: string
          master_id?: string
          price?: number
          reminder_sent?: boolean
          salon_id?: string
          service_id?: string
          source?: string
          starts_at?: string
          status?: Database["public"]["Enums"]["appointment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "appointment_import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_master_id_fkey"
            columns: ["master_id"]
            isOneToOne: false
            referencedRelation: "masters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          address: string | null
          created_at: string
          id: string
          instagram_url: string | null
          is_active: boolean
          name: string
          phone: string | null
          salon_id: string
          sort_order: number
          telegram_url: string | null
          tiktok_url: string | null
          updated_at: string
          whatsapp_url: string | null
          working_hours: Json | null
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          instagram_url?: string | null
          is_active?: boolean
          name: string
          phone?: string | null
          salon_id: string
          sort_order?: number
          telegram_url?: string | null
          tiktok_url?: string | null
          updated_at?: string
          whatsapp_url?: string | null
          working_hours?: Json | null
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          instagram_url?: string | null
          is_active?: boolean
          name?: string
          phone?: string | null
          salon_id?: string
          sort_order?: number
          telegram_url?: string | null
          tiktok_url?: string | null
          updated_at?: string
          whatsapp_url?: string | null
          working_hours?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "branches_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branches_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      error_logs: {
        Row: {
          context: Json | null
          fingerprint: string | null
          id: number
          level: string
          message: string
          salon_id: string | null
          source: string
          stack: string | null
          ts: string
          user_id: string | null
        }
        Insert: {
          context?: Json | null
          fingerprint?: string | null
          id?: number
          level: string
          message: string
          salon_id?: string | null
          source: string
          stack?: string | null
          ts?: string
          user_id?: string | null
        }
        Update: {
          context?: Json | null
          fingerprint?: string | null
          id?: number
          level?: string
          message?: string
          salon_id?: string | null
          source?: string
          stack?: string | null
          ts?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "error_logs_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "error_logs_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      excluded_contacts: {
        Row: {
          created_at: string
          id: string
          label: string | null
          phone: string
          salon_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          phone: string
          salon_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          phone?: string
          salon_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "excluded_contacts_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excluded_contacts_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      instagram_comment_events: {
        Row: {
          comment_id: string
          commenter_id: string | null
          created_at: string
          error: string | null
          media_id: string | null
          outcome: string
          salon_id: string
          trigger_id: string | null
        }
        Insert: {
          comment_id: string
          commenter_id?: string | null
          created_at?: string
          error?: string | null
          media_id?: string | null
          outcome: string
          salon_id: string
          trigger_id?: string | null
        }
        Update: {
          comment_id?: string
          commenter_id?: string | null
          created_at?: string
          error?: string | null
          media_id?: string | null
          outcome?: string
          salon_id?: string
          trigger_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "instagram_comment_events_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instagram_comment_events_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instagram_comment_events_trigger_id_fkey"
            columns: ["trigger_id"]
            isOneToOne: false
            referencedRelation: "instagram_comment_triggers"
            referencedColumns: ["id"]
          },
        ]
      }
      instagram_comment_triggers: {
        Row: {
          ai_context: string | null
          created_at: string
          enabled: boolean
          id: string
          keyword: string
          match_mode: string
          media_id: string | null
          public_reply: string | null
          reply_text: string
          salon_id: string
          updated_at: string
        }
        Insert: {
          ai_context?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          keyword: string
          match_mode?: string
          media_id?: string | null
          public_reply?: string | null
          reply_text: string
          salon_id: string
          updated_at?: string
        }
        Update: {
          ai_context?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          keyword?: string
          match_mode?: string
          media_id?: string | null
          public_reply?: string | null
          reply_text?: string
          salon_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "instagram_comment_triggers_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instagram_comment_triggers_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      master_day_overrides: {
        Row: {
          created_at: string
          date: string
          id: string
          intervals: Json | null
          is_off: boolean
          kind: string
          master_id: string
          note: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          date: string
          id?: string
          intervals?: Json | null
          is_off?: boolean
          kind?: string
          master_id: string
          note?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          date?: string
          id?: string
          intervals?: Json | null
          is_off?: boolean
          kind?: string
          master_id?: string
          note?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "master_day_overrides_master_id_fkey"
            columns: ["master_id"]
            isOneToOne: false
            referencedRelation: "masters"
            referencedColumns: ["id"]
          },
        ]
      }
      master_schedules: {
        Row: {
          end_time: string
          id: string
          master_id: string
          start_time: string
          weekday: number
        }
        Insert: {
          end_time: string
          id?: string
          master_id: string
          start_time: string
          weekday: number
        }
        Update: {
          end_time?: string
          id?: string
          master_id?: string
          start_time?: string
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "master_schedules_master_id_fkey"
            columns: ["master_id"]
            isOneToOne: false
            referencedRelation: "masters"
            referencedColumns: ["id"]
          },
        ]
      }
      master_services: {
        Row: {
          master_id: string
          service_id: string
        }
        Insert: {
          master_id: string
          service_id: string
        }
        Update: {
          master_id?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "master_services_master_id_fkey"
            columns: ["master_id"]
            isOneToOne: false
            referencedRelation: "masters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      master_time_off: {
        Row: {
          ends_at: string
          id: string
          master_id: string
          reason: string | null
          starts_at: string
        }
        Insert: {
          ends_at: string
          id?: string
          master_id: string
          reason?: string | null
          starts_at: string
        }
        Update: {
          ends_at?: string
          id?: string
          master_id?: string
          reason?: string | null
          starts_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "master_time_off_master_id_fkey"
            columns: ["master_id"]
            isOneToOne: false
            referencedRelation: "masters"
            referencedColumns: ["id"]
          },
        ]
      }
      masters: {
        Row: {
          bio: string | null
          branch_id: string | null
          created_at: string
          experience_years: number | null
          id: string
          is_active: boolean
          name: string
          photo_url: string | null
          rating: number | null
          salon_id: string
          sort_order: number
          specialization: string | null
          user_id: string | null
        }
        Insert: {
          bio?: string | null
          branch_id?: string | null
          created_at?: string
          experience_years?: number | null
          id?: string
          is_active?: boolean
          name: string
          photo_url?: string | null
          rating?: number | null
          salon_id: string
          sort_order?: number
          specialization?: string | null
          user_id?: string | null
        }
        Update: {
          bio?: string | null
          branch_id?: string | null
          created_at?: string
          experience_years?: number | null
          id?: string
          is_active?: boolean
          name?: string
          photo_url?: string | null
          rating?: number | null
          salon_id?: string
          sort_order?: number
          specialization?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "masters_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "masters_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "masters_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          appointment_id: string | null
          body: string | null
          branch_id: string | null
          created_at: string
          id: string
          is_read: boolean
          salon_id: string
          title: string
          type: string
        }
        Insert: {
          appointment_id?: string | null
          body?: string | null
          branch_id?: string | null
          created_at?: string
          id?: string
          is_read?: boolean
          salon_id: string
          title: string
          type: string
        }
        Update: {
          appointment_id?: string | null
          body?: string | null
          branch_id?: string | null
          created_at?: string
          id?: string
          is_read?: boolean
          salon_id?: string
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_agents: {
        Row: {
          created_at: string
          enabled: boolean
          key: string
          name: string
          paused: boolean
          role_title: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          key: string
          name: string
          paused?: boolean
          role_title: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          key?: string
          name?: string
          paused?: boolean
          role_title?: string
        }
        Relationships: []
      }
      ops_approvals: {
        Row: {
          action: Json
          agent: string
          created_at: string
          decided_at: string | null
          executed_at: string | null
          id: number
          kind: string
          result: Json | null
          status: string
          summary: string
          tg_message_id: number | null
        }
        Insert: {
          action: Json
          agent: string
          created_at?: string
          decided_at?: string | null
          executed_at?: string | null
          id?: number
          kind: string
          result?: Json | null
          status?: string
          summary: string
          tg_message_id?: number | null
        }
        Update: {
          action?: Json
          agent?: string
          created_at?: string
          decided_at?: string | null
          executed_at?: string | null
          id?: number
          kind?: string
          result?: Json | null
          status?: string
          summary?: string
          tg_message_id?: number | null
        }
        Relationships: []
      }
      ops_audit_log: {
        Row: {
          action: string
          actor: string
          at: string
          detail: Json | null
          id: number
          ref_id: string | null
          ref_type: string | null
        }
        Insert: {
          action: string
          actor: string
          at?: string
          detail?: Json | null
          id?: number
          ref_id?: string | null
          ref_type?: string | null
        }
        Update: {
          action?: string
          actor?: string
          at?: string
          detail?: Json | null
          id?: number
          ref_id?: string | null
          ref_type?: string | null
        }
        Relationships: []
      }
      ops_config: {
        Row: {
          agents_enabled: boolean
          id: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          agents_enabled?: boolean
          id?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          agents_enabled?: boolean
          id?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      ops_events: {
        Row: {
          at: string
          handled_at: string | null
          hops: number
          id: number
          payload: Json
          source_agent: string | null
          type: string
        }
        Insert: {
          at?: string
          handled_at?: string | null
          hops?: number
          id?: number
          payload?: Json
          source_agent?: string | null
          type: string
        }
        Update: {
          at?: string
          handled_at?: string | null
          hops?: number
          id?: number
          payload?: Json
          source_agent?: string | null
          type?: string
        }
        Relationships: []
      }
      ops_kv: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      ops_leads: {
        Row: {
          company: string | null
          created_at: string
          id: number
          industry: string | null
          name: string | null
          needs: string | null
          notes: string | null
          objections: string | null
          phone: string | null
          stage: string
          updated_at: string
        }
        Insert: {
          company?: string | null
          created_at?: string
          id?: number
          industry?: string | null
          name?: string | null
          needs?: string | null
          notes?: string | null
          objections?: string | null
          phone?: string | null
          stage?: string
          updated_at?: string
        }
        Update: {
          company?: string | null
          created_at?: string
          id?: number
          industry?: string | null
          name?: string | null
          needs?: string | null
          notes?: string | null
          objections?: string | null
          phone?: string | null
          stage?: string
          updated_at?: string
        }
        Relationships: []
      }
      ops_meetings: {
        Row: {
          created_at: string
          id: number
          lead_id: number | null
          location: string | null
          notes: string | null
          starts_at: string
          status: string
        }
        Insert: {
          created_at?: string
          id?: number
          lead_id?: number | null
          location?: string | null
          notes?: string | null
          starts_at: string
          status?: string
        }
        Update: {
          created_at?: string
          id?: number
          lead_id?: number | null
          location?: string | null
          notes?: string | null
          starts_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "ops_meetings_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "ops_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_messages: {
        Row: {
          at: string
          id: number
          meta: Json | null
          role: string
          text: string | null
          thread: string
        }
        Insert: {
          at?: string
          id?: number
          meta?: Json | null
          role: string
          text?: string | null
          thread: string
        }
        Update: {
          at?: string
          id?: number
          meta?: Json | null
          role?: string
          text?: string | null
          thread?: string
        }
        Relationships: []
      }
      ops_tasks: {
        Row: {
          agent: string
          created_at: string
          detail: Json | null
          id: number
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          agent: string
          created_at?: string
          detail?: Json | null
          id?: number
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          agent?: string
          created_at?: string
          detail?: Json | null
          id?: number
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      prepayment_audit: {
        Row: {
          action: string
          actor_id: string | null
          actor_kind: string
          appointment_id: string | null
          created_at: string
          detail: Json | null
          id: string
          salon_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_kind: string
          appointment_id?: string | null
          created_at?: string
          detail?: Json | null
          id?: string
          salon_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_kind?: string
          appointment_id?: string | null
          created_at?: string
          detail?: Json | null
          id?: string
          salon_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "prepayment_audit_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepayment_audit_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepayment_audit_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      prepayment_receipt_hashes: {
        Row: {
          appointment_id: string | null
          bank: string | null
          created_at: string
          file_phash: string | null
          file_sha256: string | null
          id: string
          salon_id: string
          txn_id: string | null
        }
        Insert: {
          appointment_id?: string | null
          bank?: string | null
          created_at?: string
          file_phash?: string | null
          file_sha256?: string | null
          id?: string
          salon_id: string
          txn_id?: string | null
        }
        Update: {
          appointment_id?: string | null
          bank?: string | null
          created_at?: string
          file_phash?: string | null
          file_sha256?: string | null
          id?: string
          salon_id?: string
          txn_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "prepayment_receipt_hashes_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepayment_receipt_hashes_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepayment_receipt_hashes_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      prepayment_settings: {
        Row: {
          amount_type: string
          amount_value: number
          auto_max_amount: number | null
          created_at: string
          currency: string
          enabled: boolean
          hold_minutes: number
          instruction_en: string | null
          instruction_ky: string | null
          instruction_ru: string | null
          max_amount: number | null
          min_amount: number | null
          overrides: Json
          qr_path: string | null
          qr_url: string | null
          recipient_details: Json
          recipient_name: string | null
          salon_id: string
          updated_at: string
          verify_mode: string
        }
        Insert: {
          amount_type?: string
          amount_value?: number
          auto_max_amount?: number | null
          created_at?: string
          currency?: string
          enabled?: boolean
          hold_minutes?: number
          instruction_en?: string | null
          instruction_ky?: string | null
          instruction_ru?: string | null
          max_amount?: number | null
          min_amount?: number | null
          overrides?: Json
          qr_path?: string | null
          qr_url?: string | null
          recipient_details?: Json
          recipient_name?: string | null
          salon_id: string
          updated_at?: string
          verify_mode?: string
        }
        Update: {
          amount_type?: string
          amount_value?: number
          auto_max_amount?: number | null
          created_at?: string
          currency?: string
          enabled?: boolean
          hold_minutes?: number
          instruction_en?: string | null
          instruction_ky?: string | null
          instruction_ru?: string | null
          max_amount?: number | null
          min_amount?: number | null
          overrides?: Json
          qr_path?: string | null
          qr_url?: string | null
          recipient_details?: Json
          recipient_name?: string | null
          salon_id?: string
          updated_at?: string
          verify_mode?: string
        }
        Relationships: [
          {
            foreignKeyName: "prepayment_settings_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: true
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepayment_settings_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: true
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          branch_id: string | null
          created_at: string
          endpoint: string
          id: string
          p256dh: string
          salon_id: string | null
          updated_at: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          auth: string
          branch_id?: string | null
          created_at?: string
          endpoint: string
          id?: string
          p256dh: string
          salon_id?: string | null
          updated_at?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          auth?: string
          branch_id?: string | null
          created_at?: string
          endpoint?: string
          id?: string
          p256dh?: string
          salon_id?: string | null
          updated_at?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_counters: {
        Row: {
          bucket: string
          hits: number
          window_start: string
        }
        Insert: {
          bucket: string
          hits?: number
          window_start: string
        }
        Update: {
          bucket?: string
          hits?: number
          window_start?: string
        }
        Relationships: []
      }
      rbac_audit: {
        Row: {
          action: string
          actor_id: string | null
          after: Json | null
          before: Json | null
          created_at: string
          id: string
          salon_id: string | null
          subject_master: string | null
          subject_user: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          id?: string
          salon_id?: string | null
          subject_master?: string | null
          subject_user?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          id?: string
          salon_id?: string | null
          subject_master?: string | null
          subject_user?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rbac_audit_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rbac_audit_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rbac_audit_subject_master_fkey"
            columns: ["subject_master"]
            isOneToOne: false
            referencedRelation: "masters"
            referencedColumns: ["id"]
          },
        ]
      }
      salon_ai_assistant: {
        Row: {
          ai_category_order: string[]
          ai_hidden_categories: string[]
          ai_rules: string | null
          assistant_branch_id: string | null
          booking_link_mode: string
          client_addressing: string | null
          created_at: string
          enabled: boolean
          engine: string
          entry_service_id: string | null
          followup_delay_hours: number
          followup_enabled: boolean
          followup_text: string | null
          greeting: string | null
          industry: string
          knowledge_answers: Json
          knowledge_base: string | null
          languages: string[]
          manage_cutoff_hours: number
          min_lead_minutes: number
          pricing_rules: string | null
          reminder_lead_hours: number
          rich_formatting: boolean
          sales_mode: boolean
          sales_objections: Json
          sales_price_framing: string | null
          sales_promos: Json
          sales_style: string
          sales_usp: Json
          salon_id: string
          start_language: string
          tone_instructions: string | null
          updated_at: string
          whatsapp_phone: string | null
        }
        Insert: {
          ai_category_order?: string[]
          ai_hidden_categories?: string[]
          ai_rules?: string | null
          assistant_branch_id?: string | null
          booking_link_mode?: string
          client_addressing?: string | null
          created_at?: string
          enabled?: boolean
          engine?: string
          entry_service_id?: string | null
          followup_delay_hours?: number
          followup_enabled?: boolean
          followup_text?: string | null
          greeting?: string | null
          industry?: string
          knowledge_answers?: Json
          knowledge_base?: string | null
          languages?: string[]
          manage_cutoff_hours?: number
          min_lead_minutes?: number
          pricing_rules?: string | null
          reminder_lead_hours?: number
          rich_formatting?: boolean
          sales_mode?: boolean
          sales_objections?: Json
          sales_price_framing?: string | null
          sales_promos?: Json
          sales_style?: string
          sales_usp?: Json
          salon_id: string
          start_language?: string
          tone_instructions?: string | null
          updated_at?: string
          whatsapp_phone?: string | null
        }
        Update: {
          ai_category_order?: string[]
          ai_hidden_categories?: string[]
          ai_rules?: string | null
          assistant_branch_id?: string | null
          booking_link_mode?: string
          client_addressing?: string | null
          created_at?: string
          enabled?: boolean
          engine?: string
          entry_service_id?: string | null
          followup_delay_hours?: number
          followup_enabled?: boolean
          followup_text?: string | null
          greeting?: string | null
          industry?: string
          knowledge_answers?: Json
          knowledge_base?: string | null
          languages?: string[]
          manage_cutoff_hours?: number
          min_lead_minutes?: number
          pricing_rules?: string | null
          reminder_lead_hours?: number
          rich_formatting?: boolean
          sales_mode?: boolean
          sales_objections?: Json
          sales_price_framing?: string | null
          sales_promos?: Json
          sales_style?: string
          sales_usp?: Json
          salon_id?: string
          start_language?: string
          tone_instructions?: string | null
          updated_at?: string
          whatsapp_phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "salon_ai_assistant_assistant_branch_id_fkey"
            columns: ["assistant_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salon_ai_assistant_entry_service_id_fkey"
            columns: ["entry_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salon_ai_assistant_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: true
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salon_ai_assistant_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: true
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      salon_faqs: {
        Row: {
          answer: string
          created_at: string
          id: string
          question: string
          salon_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          answer: string
          created_at?: string
          id?: string
          question: string
          salon_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          answer?: string
          created_at?: string
          id?: string
          question?: string
          salon_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "salon_faqs_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salon_faqs_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      salon_reviews: {
        Row: {
          client_name: string
          created_at: string
          id: string
          is_published: boolean
          master_id: string | null
          rating: number
          salon_id: string
          text: string | null
        }
        Insert: {
          client_name: string
          created_at?: string
          id?: string
          is_published?: boolean
          master_id?: string | null
          rating: number
          salon_id: string
          text?: string | null
        }
        Update: {
          client_name?: string
          created_at?: string
          id?: string
          is_published?: boolean
          master_id?: string | null
          rating?: number
          salon_id?: string
          text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "salon_reviews_master_id_fkey"
            columns: ["master_id"]
            isOneToOne: false
            referencedRelation: "masters"
            referencedColumns: ["id"]
          },
        ]
      }
      salon_secrets: {
        Row: {
          greenapi_instance: string | null
          greenapi_token: string | null
          greenapi_webhook_token: string | null
          gupshup_api_key: string | null
          gupshup_app_id: string | null
          gupshup_app_name: string | null
          gupshup_connected_at: string | null
          gupshup_enabled: boolean
          gupshup_last_error: string | null
          gupshup_last_error_at: string | null
          gupshup_last_event_at: string | null
          gupshup_source_number: string | null
          gupshup_waba_id: string | null
          gupshup_webhook_token: string | null
          instagram_app_secret: string | null
          instagram_token: string | null
          instagram_user_id: string | null
          instagram_verify_token: string | null
          owner_notify_phone: string | null
          salon_id: string
          updated_at: string
          wa_make_outbound_url: string | null
          wa_make_token: string | null
          whatsapp_cloud_app_secret: string | null
          whatsapp_cloud_phone_number_id: string | null
          whatsapp_cloud_templates: Json | null
          whatsapp_cloud_token: string | null
          whatsapp_cloud_verify_token: string | null
          whatsapp_cloud_waba_id: string | null
        }
        Insert: {
          greenapi_instance?: string | null
          greenapi_token?: string | null
          greenapi_webhook_token?: string | null
          gupshup_api_key?: string | null
          gupshup_app_id?: string | null
          gupshup_app_name?: string | null
          gupshup_connected_at?: string | null
          gupshup_enabled?: boolean
          gupshup_last_error?: string | null
          gupshup_last_error_at?: string | null
          gupshup_last_event_at?: string | null
          gupshup_source_number?: string | null
          gupshup_waba_id?: string | null
          gupshup_webhook_token?: string | null
          instagram_app_secret?: string | null
          instagram_token?: string | null
          instagram_user_id?: string | null
          instagram_verify_token?: string | null
          owner_notify_phone?: string | null
          salon_id: string
          updated_at?: string
          wa_make_outbound_url?: string | null
          wa_make_token?: string | null
          whatsapp_cloud_app_secret?: string | null
          whatsapp_cloud_phone_number_id?: string | null
          whatsapp_cloud_templates?: Json | null
          whatsapp_cloud_token?: string | null
          whatsapp_cloud_verify_token?: string | null
          whatsapp_cloud_waba_id?: string | null
        }
        Update: {
          greenapi_instance?: string | null
          greenapi_token?: string | null
          greenapi_webhook_token?: string | null
          gupshup_api_key?: string | null
          gupshup_app_id?: string | null
          gupshup_app_name?: string | null
          gupshup_connected_at?: string | null
          gupshup_enabled?: boolean
          gupshup_last_error?: string | null
          gupshup_last_error_at?: string | null
          gupshup_last_event_at?: string | null
          gupshup_source_number?: string | null
          gupshup_waba_id?: string | null
          gupshup_webhook_token?: string | null
          instagram_app_secret?: string | null
          instagram_token?: string | null
          instagram_user_id?: string | null
          instagram_verify_token?: string | null
          owner_notify_phone?: string | null
          salon_id?: string
          updated_at?: string
          wa_make_outbound_url?: string | null
          wa_make_token?: string | null
          whatsapp_cloud_app_secret?: string | null
          whatsapp_cloud_phone_number_id?: string | null
          whatsapp_cloud_templates?: Json | null
          whatsapp_cloud_token?: string | null
          whatsapp_cloud_verify_token?: string | null
          whatsapp_cloud_waba_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "salon_secrets_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: true
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salon_secrets_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: true
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      salons: {
        Row: {
          about_text: string | null
          address: string | null
          ai_assistant_enabled: boolean
          brand_accent: string | null
          brand_primary: string | null
          category_order: string[]
          collapsed_categories: string[]
          created_at: string
          custom_domain: string | null
          custom_html: string | null
          description: string | null
          gallery_images: string[]
          hero_image_url: string | null
          hero_subtitle: string | null
          hero_title: string | null
          id: string
          instagram_enabled: boolean
          instagram_url: string | null
          is_active: boolean
          lat: number | null
          lng: number | null
          logo_url: string | null
          multilang_enabled: boolean
          name: string
          phone: string | null
          site_enabled: boolean
          site_template: string
          slug: string
          staff_isolation: boolean
          telegram_url: string | null
          tiktok_url: string | null
          timezone: string
          updated_at: string
          wa_cloud_templates_ready: boolean
          wa_provider: string
          whatsapp_enabled: boolean
          whatsapp_url: string | null
          working_hours: Json
        }
        Insert: {
          about_text?: string | null
          address?: string | null
          ai_assistant_enabled?: boolean
          brand_accent?: string | null
          brand_primary?: string | null
          category_order?: string[]
          collapsed_categories?: string[]
          created_at?: string
          custom_domain?: string | null
          custom_html?: string | null
          description?: string | null
          gallery_images?: string[]
          hero_image_url?: string | null
          hero_subtitle?: string | null
          hero_title?: string | null
          id?: string
          instagram_enabled?: boolean
          instagram_url?: string | null
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          logo_url?: string | null
          multilang_enabled?: boolean
          name: string
          phone?: string | null
          site_enabled?: boolean
          site_template?: string
          slug: string
          staff_isolation?: boolean
          telegram_url?: string | null
          tiktok_url?: string | null
          timezone?: string
          updated_at?: string
          wa_cloud_templates_ready?: boolean
          wa_provider?: string
          whatsapp_enabled?: boolean
          whatsapp_url?: string | null
          working_hours?: Json
        }
        Update: {
          about_text?: string | null
          address?: string | null
          ai_assistant_enabled?: boolean
          brand_accent?: string | null
          brand_primary?: string | null
          category_order?: string[]
          collapsed_categories?: string[]
          created_at?: string
          custom_domain?: string | null
          custom_html?: string | null
          description?: string | null
          gallery_images?: string[]
          hero_image_url?: string | null
          hero_subtitle?: string | null
          hero_title?: string | null
          id?: string
          instagram_enabled?: boolean
          instagram_url?: string | null
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          logo_url?: string | null
          multilang_enabled?: boolean
          name?: string
          phone?: string | null
          site_enabled?: boolean
          site_template?: string
          slug?: string
          staff_isolation?: boolean
          telegram_url?: string | null
          tiktok_url?: string | null
          timezone?: string
          updated_at?: string
          wa_cloud_templates_ready?: boolean
          wa_provider?: string
          whatsapp_enabled?: boolean
          whatsapp_url?: string | null
          working_hours?: Json
        }
        Relationships: []
      }
      service_addons: {
        Row: {
          created_at: string
          duration_min: number
          id: string
          is_active: boolean
          name: string
          price: number
          salon_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          duration_min?: number
          id?: string
          is_active?: boolean
          name: string
          price?: number
          salon_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          duration_min?: number
          id?: string
          is_active?: boolean
          name?: string
          price?: number
          salon_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_addons_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_addons_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          buffer_after_min: number
          category: string | null
          color: string | null
          created_at: string
          description: string | null
          duration_max_min: number | null
          duration_min: number
          id: string
          is_active: boolean
          name: string
          price: number
          price_max: number | null
          price_type: string
          salon_id: string
          sort_order: number
        }
        Insert: {
          buffer_after_min?: number
          category?: string | null
          color?: string | null
          created_at?: string
          description?: string | null
          duration_max_min?: number | null
          duration_min: number
          id?: string
          is_active?: boolean
          name: string
          price?: number
          price_max?: number | null
          price_type?: string
          salon_id: string
          sort_order?: number
        }
        Update: {
          buffer_after_min?: number
          category?: string | null
          color?: string | null
          created_at?: string
          description?: string | null
          duration_max_min?: number | null
          duration_min?: number
          id?: string
          is_active?: boolean
          name?: string
          price?: number
          price_max?: number | null
          price_type?: string
          salon_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "services_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          branch_id: string | null
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          salon_id: string | null
          user_id: string
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          salon_id?: string | null
          user_id: string
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          salon_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      wa_conversations: {
        Row: {
          ai_paused: boolean
          ai_paused_at: string | null
          appointment_id: string | null
          channel: string
          client_name: string | null
          client_phone: string
          created_at: string
          external_id: string | null
          followup_sent_at: string | null
          id: string
          last_appointment_at: string | null
          last_message_at: string
          last_message_preview: string | null
          processing_lock_id: string | null
          processing_lock_until: string | null
          salon_id: string
          selected_branch_id: string | null
          session_started_at: string
          state: string
          state_data: Json
          status: string
          updated_at: string
        }
        Insert: {
          ai_paused?: boolean
          ai_paused_at?: string | null
          appointment_id?: string | null
          channel?: string
          client_name?: string | null
          client_phone: string
          created_at?: string
          external_id?: string | null
          followup_sent_at?: string | null
          id?: string
          last_appointment_at?: string | null
          last_message_at?: string
          last_message_preview?: string | null
          processing_lock_id?: string | null
          processing_lock_until?: string | null
          salon_id: string
          selected_branch_id?: string | null
          session_started_at?: string
          state?: string
          state_data?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          ai_paused?: boolean
          ai_paused_at?: string | null
          appointment_id?: string | null
          channel?: string
          client_name?: string | null
          client_phone?: string
          created_at?: string
          external_id?: string | null
          followup_sent_at?: string | null
          id?: string
          last_appointment_at?: string | null
          last_message_at?: string
          last_message_preview?: string | null
          processing_lock_id?: string | null
          processing_lock_until?: string | null
          salon_id?: string
          selected_branch_id?: string | null
          session_started_at?: string
          state?: string
          state_data?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wa_conversations_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_conversations_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_conversations_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_conversations_selected_branch_id_fkey"
            columns: ["selected_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      wa_messages: {
        Row: {
          conversation_id: string
          created_at: string
          direction: string
          green_api_message_id: string | null
          id: string
          kind: string
          media_path: string | null
          meta: Json | null
          processed_at: string | null
          provider: string | null
          provider_message_id: string | null
          salon_id: string
          text_body: string | null
        }
        Insert: {
          conversation_id: string
          created_at?: string
          direction: string
          green_api_message_id?: string | null
          id?: string
          kind?: string
          media_path?: string | null
          meta?: Json | null
          processed_at?: string | null
          provider?: string | null
          provider_message_id?: string | null
          salon_id: string
          text_body?: string | null
        }
        Update: {
          conversation_id?: string
          created_at?: string
          direction?: string
          green_api_message_id?: string | null
          id?: string
          kind?: string
          media_path?: string | null
          meta?: Json | null
          processed_at?: string | null
          provider?: string | null
          provider_message_id?: string | null
          salon_id?: string
          text_body?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wa_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "wa_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_messages_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_messages_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
      wa_webhook_events: {
        Row: {
          attempts: number
          event_type: string | null
          external_id: string | null
          id: string
          last_error: string | null
          processed_at: string | null
          provider: string
          raw: Json
          received_at: string
          salon_id: string | null
        }
        Insert: {
          attempts?: number
          event_type?: string | null
          external_id?: string | null
          id?: string
          last_error?: string | null
          processed_at?: string | null
          provider: string
          raw: Json
          received_at?: string
          salon_id?: string | null
        }
        Update: {
          attempts?: number
          event_type?: string | null
          external_id?: string | null
          id?: string
          last_error?: string | null
          processed_at?: string | null
          provider?: string
          raw?: Json
          received_at?: string
          salon_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wa_webhook_events_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wa_webhook_events_salon_id_fkey"
            columns: ["salon_id"]
            isOneToOne: false
            referencedRelation: "salons_public"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      salons_public: {
        Row: {
          address: string | null
          brand_accent: string | null
          brand_primary: string | null
          custom_domain: string | null
          description: string | null
          id: string | null
          is_active: boolean | null
          logo_url: string | null
          name: string | null
          phone: string | null
          slug: string | null
          timezone: string | null
        }
        Insert: {
          address?: string | null
          brand_accent?: string | null
          brand_primary?: string | null
          custom_domain?: string | null
          description?: string | null
          id?: string | null
          is_active?: boolean | null
          logo_url?: string | null
          name?: string | null
          phone?: string | null
          slug?: string | null
          timezone?: string | null
        }
        Update: {
          address?: string | null
          brand_accent?: string | null
          brand_primary?: string | null
          custom_domain?: string | null
          description?: string | null
          id?: string | null
          is_active?: boolean | null
          logo_url?: string | null
          name?: string | null
          phone?: string | null
          slug?: string | null
          timezone?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      alert_silent_salons: { Args: never; Returns: undefined }
      archive_old_appointments: { Args: never; Returns: number }
      assert_master_available: {
        Args: {
          _ends_at: string
          _master_id: string
          _service_id: string
          _starts_at: string
        }
        Returns: undefined
      }
      cancel_appointment_by_token: { Args: { _token: string }; Returns: Json }
      confirm_prepayment: {
        Args: { _appointment_id: string }
        Returns: undefined
      }
      create_appointment: {
        Args: {
          _addon_ids?: string[]
          _branch_id?: string
          _client_name: string
          _client_notes?: string
          _client_phone: string
          _duration_override_min?: number
          _hold_minutes?: number
          _master_id: string
          _price_override?: number
          _salon_id: string
          _service_id: string
          _source?: string
          _starts_at: string
        }
        Returns: string
      }
      create_appointment_with_prepayment: {
        Args: {
          _addon_ids?: string[]
          _branch_id?: string
          _client_name: string
          _client_notes?: string
          _client_phone: string
          _duration_override_min?: number
          _master_id: string
          _price_override?: number
          _salon_id: string
          _service_id: string
          _source?: string
          _starts_at: string
        }
        Returns: Json
      }
      get_addons_for_service: {
        Args: { _service_id: string }
        Returns: {
          duration_min: number
          id: string
          name: string
          price: number
        }[]
      }
      get_appointment_by_token: { Args: { _token: string }; Returns: Json }
      get_available_slots: {
        Args: { _date: string; _master_id: string; _service_id: string }
        Returns: {
          slot_end: string
          slot_start: string
        }[]
      }
      get_due_reminders: {
        Args: never
        Returns: {
          id: string
        }[]
      }
      get_prepayment_by_token: { Args: { _token: string }; Returns: Json }
      get_salon_by_host: {
        Args: { _host: string }
        Returns: {
          about_text: string
          address: string
          brand_accent: string
          brand_primary: string
          custom_domain: string
          custom_html: string
          description: string
          gallery_images: string[]
          hero_image_url: string
          hero_subtitle: string
          hero_title: string
          id: string
          instagram_url: string
          lat: number
          lng: number
          logo_url: string
          multilang_enabled: boolean
          name: string
          phone: string
          site_enabled: boolean
          site_template: string
          slug: string
          telegram_url: string
          tiktok_url: string
          timezone: string
          whatsapp_enabled: boolean
          whatsapp_url: string
          working_hours: Json
        }[]
      }
      has_branch_access: {
        Args: { _branch_id: string; _user_id: string }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_salon_access: {
        Args: { _salon_id: string; _user_id: string }
        Returns: boolean
      }
      has_salon_ops_access: {
        Args: { _salon_id: string; _user_id: string }
        Returns: boolean
      }
      internal_get_cron_secret: { Args: never; Returns: string }
      master_branch_id: { Args: { _user_id: string }; Returns: string }
      master_salon_id: { Args: { _user_id: string }; Returns: string }
      notify_owner_self_service: {
        Args: { _appointment_id: string; _kind: string }
        Returns: undefined
      }
      ops_digest_snapshot: { Args: never; Returns: Json }
      ops_recent_errors: {
        Args: { _since: string }
        Returns: {
          affected_salons: number
          cnt: number
          fingerprint: string
          last_ts: string
          sample_message: string
          source: string
        }[]
      }
      ops_salon_overview: {
        Args: never
        Returns: {
          ai_bookings_7d: number
          ai_enabled: boolean
          bookings_7d: number
          conversations_7d: number
          engine: string
          has_credentials: boolean
          last_activity: string
          no_show_30d: number
          salon_id: string
          salon_name: string
          whatsapp_enabled: boolean
        }[]
      }
      prepayment_expire_holds: { Args: never; Returns: number }
      prune_error_logs: { Args: never; Returns: undefined }
      prune_rate_limit_counters: { Args: never; Returns: undefined }
      rate_limit_hit: {
        Args: { _bucket: string; _limit: number; _window: string }
        Returns: boolean
      }
      reschedule_appointment: {
        Args: { _appointment_id: string; _new_starts_at: string }
        Returns: string
      }
      reschedule_appointment_by_token: {
        Args: { _new_starts_at: string; _token: string }
        Returns: Json
      }
      reschedule_appointment_v2: {
        Args: {
          _appointment_id: string
          _new_master_id?: string
          _new_starts_at: string
        }
        Returns: string
      }
      salon_local_tz: { Args: { _salon_id: string }; Returns: string }
      user_manager_salon_id: { Args: { _user_id: string }; Returns: string }
      user_master_ids: { Args: { _user_id: string }; Returns: string[] }
      wa_check_rate_limit: { Args: { _salon_id: string }; Returns: boolean }
      wa_release_lock: {
        Args: { _conversation_id: string; _lock_id: string }
        Returns: undefined
      }
      wa_run_reconciliation: { Args: never; Returns: number }
      wa_try_acquire_lock: {
        Args: {
          _conversation_id: string
          _lock_id: string
          _ttl_seconds?: number
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "super_admin" | "salon_admin" | "master" | "manager"
      appointment_status:
        | "confirmed"
        | "cancelled"
        | "completed"
        | "no_show"
        | "pending_payment"
        | "payment_expired"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["super_admin", "salon_admin", "master", "manager"],
      appointment_status: [
        "confirmed",
        "cancelled",
        "completed",
        "no_show",
        "pending_payment",
        "payment_expired",
      ],
    },
  },
} as const
