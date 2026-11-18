// OpenTravel Alliance (OTA) XML messages, the format most Indian channel managers accept in some dialect.
// DRAFT: eZee and STAAH each publish their own variant; these builders are the starting point and must be
// adjusted to their specs and passed through their certification before going live.
import type { AriDay, BookingMessage } from './types.ts';

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const amount = (paise: number) => (paise / 100).toFixed(2);
const head = (name: string, echoToken: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<${name} xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="${esc(echoToken)}" TimeStamp="${new Date().toISOString()}" Version="1.0">`;

export function availNotif(hotelCode: string, days: AriDay[], echoToken: string): string {
  const items = days
    .map((d) => {
      const restrictions = [
        `<RestrictionStatus Status="${d.closed ? 'Close' : 'Open'}"/>`,
        d.closedToArrival ? `<RestrictionStatus Restriction="Arrival" Status="Close"/>` : '',
        d.closedToDeparture ? `<RestrictionStatus Restriction="Departure" Status="Close"/>` : '',
        d.minStay ? `<LengthsOfStay><LengthOfStay MinMaxMessageType="SetMinLOS" Time="${d.minStay}"/></LengthsOfStay>` : '',
      ].join('');
      return `<AvailStatusMessage BookingLimit="${Math.max(d.available, 0)}"><StatusApplicationControl Start="${d.date}" End="${d.date}" InvTypeCode="${esc(d.roomCode)}"/>${restrictions}</AvailStatusMessage>`;
    })
    .join('');
  return `${head('OTA_HotelAvailNotifRQ', echoToken)}<AvailStatusMessages HotelCode="${esc(hotelCode)}">${items}</AvailStatusMessages></OTA_HotelAvailNotifRQ>`;
}

export function rateAmountNotif(hotelCode: string, days: AriDay[], currency: string, echoToken: string): string {
  const items = days
    .flatMap((d) =>
      d.rates
        .filter((r) => r.price !== null)
        .map(
          (r) =>
            `<RateAmountMessage><StatusApplicationControl Start="${d.date}" End="${d.date}" InvTypeCode="${esc(d.roomCode)}" RatePlanCode="${esc(r.rateCode)}"/>` +
            `<Rates><Rate><BaseByGuestAmts><BaseByGuestAmt AmountBeforeTax="${amount(r.price!)}" CurrencyCode="${currency}"/></BaseByGuestAmts>` +
            (r.extraAdult || r.extraChild
              ? `<AdditionalGuestAmounts>${r.extraAdult ? `<AdditionalGuestAmount AgeQualifyingCode="10" Amount="${amount(r.extraAdult)}"/>` : ''}${r.extraChild ? `<AdditionalGuestAmount AgeQualifyingCode="8" Amount="${amount(r.extraChild)}"/>` : ''}</AdditionalGuestAmounts>`
              : '') +
            `</Rate></Rates></RateAmountMessage>`,
        ),
    )
    .join('');
  return `${head('OTA_HotelRateAmountNotifRQ', echoToken)}<RateAmountMessages HotelCode="${esc(hotelCode)}">${items}</RateAmountMessages></OTA_HotelRateAmountNotifRQ>`;
}

export function resNotif(hotelCode: string, b: BookingMessage, echoToken: string): string {
  const status = b.status === 'cancelled' ? 'Cancel' : 'Commit';
  const rooms = b.rooms
    .map(
      (r, i) =>
        `<RoomStay IndexNumber="${i + 1}"><RoomTypes><RoomType RoomTypeCode="${esc(r.roomCode)}"/></RoomTypes>` +
        (r.rateCode ? `<RatePlans><RatePlan RatePlanCode="${esc(r.rateCode)}"/></RatePlans>` : '') +
        `<GuestCounts><GuestCount AgeQualifyingCode="10" Count="${r.adults}"/>${r.children ? `<GuestCount AgeQualifyingCode="8" Count="${r.children}"/>` : ''}</GuestCounts>` +
        `<TimeSpan Start="${b.checkIn}" End="${b.checkOut}"/><Total AmountAfterTax="${amount(r.amount)}" CurrencyCode="${b.currency}"/></RoomStay>`,
    )
    .join('');
  const [given, ...rest] = b.guest.name.split(' ');
  return (
    `${head('OTA_HotelResNotifRQ', echoToken)}<HotelReservations><HotelReservation CreateDateTime="${b.createdAt}" ResStatus="${status}">` +
    `<RoomStays>${rooms}</RoomStays>` +
    `<ResGuests><ResGuest><Profiles><ProfileInfo><Profile><Customer><PersonName><GivenName>${esc(given ?? '')}</GivenName><Surname>${esc(rest.join(' '))}</Surname></PersonName>` +
    (b.guest.phone ? `<Telephone PhoneNumber="${esc(b.guest.phone)}"/>` : '') +
    (b.guest.email ? `<Email>${esc(b.guest.email)}</Email>` : '') +
    `</Customer></Profile></ProfileInfo></Profiles></ResGuest></ResGuests>` +
    `<ResGlobalInfo><HotelReservationIDs><HotelReservationID ResID_Type="14" ResID_Value="${esc(b.reference)}"/></HotelReservationIDs>` +
    `<Total AmountAfterTax="${amount(b.total)}" CurrencyCode="${b.currency}"/><BasicPropertyInfo HotelCode="${esc(hotelCode)}"/>` +
    (b.specialRequests ? `<Comments><Comment><Text>${esc(b.specialRequests)}</Text></Comment></Comments>` : '') +
    `</ResGlobalInfo></HotelReservation></HotelReservations></OTA_HotelResNotifRQ>`
  );
}
