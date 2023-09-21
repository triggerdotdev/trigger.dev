export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      todos: {
        Row: {
          contents: string | null;
          created_at: string | null;
          id: number;
          is_complete: boolean | null;
          user_id: number | null;
        };
        Insert: {
          contents?: string | null;
          created_at?: string | null;
          id?: number;
          is_complete?: boolean | null;
          user_id?: number | null;
        };
        Update: {
          contents?: string | null;
          created_at?: string | null;
          id?: number;
          is_complete?: boolean | null;
          user_id?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "todos_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      users: {
        Row: {
          created_at: string | null;
          email_address: string | null;
          first_name: string | null;
          id: number;
          last_name: string | null;
        };
        Insert: {
          created_at?: string | null;
          email_address?: string | null;
          first_name?: string | null;
          id?: number;
          last_name?: string | null;
        };
        Update: {
          created_at?: string | null;
          email_address?: string | null;
          first_name?: string | null;
          id?: number;
          last_name?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public_2: {
    Tables: {
      tweets: {
        Row: {
          content: string;
          created_at: string | null;
          id: number;
          tweet_id: string;
        };
        Insert: {
          content: string;
          created_at?: string | null;
          id?: number;
          tweet_id: string;
        };
        Update: {
          content?: string;
          created_at?: string | null;
          id?: number;
          tweet_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}
