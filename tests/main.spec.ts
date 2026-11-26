/**
 * The main run (`npm test`): every step in tests/main, in THIS order. Playwright runs the tests of one file in the
 * order they are defined, so the imports below set the run order — not the file names. Test cases are numbered
 * TC1–TC57 in this order.
 *
 * A new case goes into the file of its step. A new step is a new file in tests/main, imported here at its place.
 * Each step's groups carry a tag (e.g. @wallet-credit), so one step runs on its own with --grep (npm run test:wallet …).
 */
import "./main/card-flow"; // TC1–6    login -> create -> reschedule -> group size -> extend -> cancel (card)   @card-flow
import "./main/card-quick-shift"; // TC7–12   15 min earlier / later (card)                                  @card-quick-shift
import "./main/card-refund"; // TC13–18  cancel: 50% refund / no refund (card)                                @card-refund
import "./main/card-switch-bay"; // TC19–24  extend to another bay / Switch to Trackman (card)                @card-switch-bay
import "./main/wallet"; // TC25–32  wallet credit: create -> reschedule -> group size -> extend -> cancel       @wallet-credit
import "./main/wallet-gift-card"; // TC33–34  wallet + gift card, card + wallet + gift card (book + cancel)   @wallet-gift-card
import "./main/gift-card"; // TC35–40  gift card: create -> reschedule -> extend -> cancel                     @gift-card
import "./main/membership"; // TC41–57  Core, Elite upgrade, cancel and keep membership                       @membership
