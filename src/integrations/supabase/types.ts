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
      appointments: {
        Row: {
          branch_id: string | null
          client_name: string
          client_notes: string | null
          client_phone: string
          created_at: string
          ends_at: string
          id: string
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
          created_at?: string
          ends_at: string
          id?: string
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
          created_at?: string
          ends_at?: string
          id?: string
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
          id: string
          is_active: boolean
          name: string
          photo_url: string | null
          salon_id: string
          sort_order: number
          specialization: string | null
        }
        Insert: {
          bio?: string | null
          branch_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          photo_url?: string | null
          salon_id: string
          sort_order?: number
          specialization?: string | null
        }
        Update: {
          bio?: string | null
          branch_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          photo_url?: string | null
          salon_id?: string
          sort_order?: number
          specialization?: string | null
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
      salon_ai_assistant: {
        Row: {
          ai_category_order: string[]
          ai_hidden_categories: string[]
          created_at: string
          enabled: boolean
          greeting: string | null
          languages: string[]
          manage_cutoff_hours: number
          pricing_rules: string | null
          salon_id: string
          tone_instructions: string | null
          updated_at: string
          whatsapp_phone: string | null
        }
        Insert: {
          ai_category_order?: string[]
          ai_hidden_categories?: string[]
          created_at?: string
          enabled?: boolean
          greeting?: string | null
          languages?: string[]
          manage_cutoff_hours?: number
          pricing_rules?: string | null
          salon_id: string
          tone_instructions?: string | null
          updated_at?: string
          whatsapp_phone?: string | null
        }
        Update: {
          ai_category_order?: string[]
          ai_hidden_categories?: string[]
          created_at?: string
          enabled?: boolean
          greeting?: string | null
          languages?: string[]
          manage_cutoff_hours?: number
          pricing_rules?: string | null
          salon_id?: string
          tone_instructions?: string | null
          updated_at?: string
          whatsapp_phone?: string | null
        }
        Relationships: [
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
          rating: number
          salon_id: string
          text: string | null
        }
        Insert: {
          client_name: string
          created_at?: string
          id?: string
          is_published?: boolean
          rating: number
          salon_id: string
          text?: string | null
        }
        Update: {
          client_name?: string
          created_at?: string
          id?: string
          is_published?: boolean
          rating?: number
          salon_id?: string
          text?: string | null
        }
        Relationships: []
      }
      salon_secrets: {
        Row: {
          greenapi_instance: string | null
          greenapi_token: string | null
          greenapi_webhook_token: string | null
          owner_notify_phone: string | null
          salon_id: string
          updated_at: string
        }
        Insert: {
          greenapi_instance?: string | null
          greenapi_token?: string | null
          greenapi_webhook_token?: string | null
          owner_notify_phone?: string | null
          salon_id: string
          updated_at?: string
        }
        Update: {
          greenapi_instance?: string | null
          greenapi_token?: string | null
          greenapi_webhook_token?: string | null
          owner_notify_phone?: string | null
          salon_id?: string
          updated_at?: string
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
          telegram_url: string | null
          tiktok_url: string | null
          timezone: string
          updated_at: string
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
          telegram_url?: string | null
          tiktok_url?: string | null
          timezone?: string
          updated_at?: string
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
          telegram_url?: string | null
          tiktok_url?: string | null
          timezone?: string
          updated_at?: string
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
          client_name: string | null
          client_phone: string
          created_at: string
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
          client_name?: string | null
          client_phone: string
          created_at?: string
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
          client_name?: string | null
          client_phone?: string
          created_at?: string
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
      archive_old_appointments: { Args: never; Returns: number }
      create_appointment: {
        Args: {
          _addon_ids?: string[]
          _branch_id?: string
          _client_name: string
          _client_notes?: string
          _client_phone: string
          _master_id: string
          _price_override?: number
          _salon_id: string
          _service_id: string
          _source?: string
          _starts_at: string
        }
        Returns: string
      }
      drain_pending_wa_conversations: { Args: never; Returns: undefined }
      get_addons_for_service: {
        Args: { _service_id: string }
        Returns: {
          duration_min: number
          id: string
          name: string
          price: number
        }[]
      }
      get_available_slots: {
        Args: { _date: string; _master_id: string; _service_id: string }
        Returns: {
          slot_end: string
          slot_start: string
        }[]
      }
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
      internal_get_cron_secret: { Args: never; Returns: string }
      master_branch_id: { Args: { _user_id: string }; Returns: string }
      master_salon_id: { Args: { _user_id: string }; Returns: string }
      wa_release_lock: {
        Args: { _conversation_id: string; _lock_id: string }
        Returns: undefined
      }
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
      app_role: "super_admin" | "salon_admin" | "master"
      appointment_status: "confirmed" | "cancelled" | "completed" | "no_show"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      app_role: ["super_admin", "salon_admin", "master"],
      appointment_status: ["confirmed", "cancelled", "completed", "no_show"],
    },
  },
} as const
