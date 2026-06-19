export interface Contact {
  id: string;
  phone: string;
  name: string | null;
  isAdmin: boolean;
}

export interface ContactsFile {
  group: {
    id: string;
    name: string;
  };
  exportedAt: string;
  contacts: Contact[];
}

export interface SendLog {
  sentIds: string[];
  startedAt: string;
}
