import { makeZoeHelpers, defaultAcceptanceMsg } from './helpers/zoeHelpers';

import produceIssuer from '@agoric/ertp';

/*
  Roles in the arrangement:
  - Contract creator: describes the contract with:
    - number of seats, show, date/time of start
    - expected (ERTP) amount per ticket (we assume all tickets cost the same)
  - Smart Contract: 
    - mints the tickets
    - provides the seats
  - Auditorium (unique contract seat, usually taken by the contract creator): the person hosting 
  the Opera show, selling the tickets and getting the payment back
  - Ticket buyers (contract seat created on demand): 
    - can see the available opera show seats
    - can consult the terms
    - can redeem the zoe invite with the proper payment to get the ticket back
*/

export const makeContract = harden(async zoe => {

  const zoeService = zoe.getZoeService();

  const {
    rejectOffer,
    checkIfProposal,
    swap,
    canTradeWith,
    getActiveOffers,
    assertKeywords,
  } = makeZoeHelpers(zoe);

  // Create the internal ticket mint
  const { issuer, mint, amountMath } = produceIssuer('Opera tickets', 'set');
  await zoe.addNewIssuer(issuer, 'Auditorium');
  
  const { terms: { show, start, count, expectedAmountPerTicket } } = zoe.getInstanceRecord();
  
  const ticketDescriptionObjects = Array(count)
    .fill()
    .map((_, i) => harden({ show, start, number: i + 1 }));

  const availableTicketAmountsByTicketNumber = new Map(
    ticketDescriptionObjects.map(description => [description.number, amountMath.make(harden([description]))])
  )

  // Create the offers in Zoe for the tickets
  const ticketPaymentInviteHandles = new Map(await Promise.all(
    [...availableTicketAmountsByTicketNumber.entries()].map(([ticketNumber, amount]) => {
      // create an Zoe invite internally...
      const {invite, inviteHandle} = zoe.makeInvite()
      // ...and redeem it right away
      return zoeService.redeem(
        invite,
        harden({want: {Buyer: expectedAmountPerTicket}, give: {Auditorium: amount}}),
        harden({Auditorium: mint.mintPayment(amount)}) // mint and pass to Zoe right away
      ).then(({payout}) => {
        return [ticketNumber, {payout, inviteHandle}]
      })
    })
  ))

  console.log('ticketPaymentInviteHandles', ticketPaymentInviteHandles)

  
  const auditoriumSeat = harden({
    getSalesMoney(){
      throw `TODO`
    }
  })
  const auditoriumInvite = zoe.makeInvite(auditoriumSeat);

  const makeBuyerInvite = () => {
    const seat = harden({
      performExchange: () => {
        const buyerInviteHandle = inviteHandle;
        const buyerOffer = zoe.getOffer(buyerInviteHandle)
        console.log('performExchange offer', buyerOffer)

        const buyerWant = buyerOffer.proposal.want.Auditorium;
        console.log('want', buyerWant)

        const ticketNumber = buyerWant.extent[0].number
        console.log('ticketNumber', ticketNumber)

        if(!availableTicketAmountsByTicketNumber.has(ticketNumber)){
          rejectOffer(`Ticket #${ticketNumber} is not available anymore`);
        }

        const ticketInviteHandle = ticketPaymentInviteHandles.get(ticketNumber)

        // total bluff
        return swap(ticketInviteHandle, buyerInviteHandle)
      },
    });
    const { invite, inviteHandle } = zoe.makeInvite(seat);
    return { invite, inviteHandle };
  };

  return harden({
    invite: auditoriumInvite,
    publicAPI: { 
      makeBuyerInvite,
      getTicketIssuer(){
        throw `TODO`
      },
      getAvailableTickets(){
        return new Map(availableTicketAmountsByTicketNumber);
      }
    },
  });
});
