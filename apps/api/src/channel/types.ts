// The shapes Midotel exchanges with any channel manager, independent of each provider's wire format.

export interface AriRate {
  rateCode: string;
  /** Price for the room's base occupancy, in paise, or null when no price is loaded. */
  price: number | null;
  extraAdult: number | null;
  extraChild: number | null;
}

/** Availability, restrictions and rates for one room type on one night. */
export interface AriDay {
  roomCode: string;
  date: string;
  available: number;
  closed: boolean;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  minStay: number | null;
  maxStay: number | null;
  rates: AriRate[];
}

export interface BookingMessage {
  reference: string;
  status: 'confirmed' | 'cancelled';
  createdAt: string;
  checkIn: string;
  checkOut: string;
  currency: string;
  total: number;
  paid: number;
  guest: { name: string; email: string | null; phone: string | null };
  specialRequests: string | null;
  rooms: { roomCode: string; rateCode: string | null; adults: number; children: number; amount: number }[];
}

/** What a channel manager can tell us. */
export type InboundEvent =
  | {
      type: 'booking';
      action: 'new' | 'modify' | 'cancel';
      externalReference: string;
      channelName: string | null;
      checkIn: string;
      checkOut: string;
      currency: string;
      total: number; // paise, including taxes
      guest: { name: string; email: string | null; phone: string | null };
      specialRequests: string | null;
      rooms: { roomCode: string; rateCode: string | null; adults: number; children: number }[];
    }
  | {
      type: 'ari';
      updates: {
        roomCode: string;
        rateCode: string | null;
        from: string;
        to: string; // inclusive
        price?: number; // paise
        available?: number;
        closed?: boolean;
      }[];
    };

export interface ConnectionInfo {
  id: string;
  provider: 'ezee' | 'staah' | 'simulator';
  hotelCode: string;
  endpointUrl: string | null;
  credentials: Record<string, string> | null;
}

export interface ChannelAdapter {
  provider: ConnectionInfo['provider'];
  /** False while the provider's real API is not yet implemented and certified. */
  certified: boolean;
  pushAri(conn: ConnectionInfo, days: AriDay[]): Promise<void>;
  pushBooking(conn: ConnectionInfo, booking: BookingMessage): Promise<void>;
  parseInbound(body: string, contentType: string): InboundEvent[];
}
