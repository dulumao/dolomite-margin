import BigNumber from 'bignumber.js';
import { getDolomiteMargin } from '../helpers/DolomiteMargin';
import { TestDolomiteMargin } from '../modules/TestDolomiteMargin';
import { fastForward, mineAvgBlock, resetEVM, snapshot } from '../helpers/EVM';
import { setGlobalOperator, setupMarkets } from '../helpers/DolomiteMarginHelpers';
import { expectThrow } from '../helpers/Expect';
import { AccountStatus, address, ADDRESSES, INTEGERS } from '../../src';

let dolomiteMargin: TestDolomiteMargin;
let accounts: address[];
let snapshotId: string;
let admin: address;
let owner1: address;
let owner2: address;
let operator: address;

const accountNumber1 = new BigNumber(111);
const accountNumber2 = new BigNumber(222);
const market1 = INTEGERS.ZERO;
const market2 = INTEGERS.ONE;
const market3 = new BigNumber(2);
const market4 = new BigNumber(3);
const zero = new BigNumber(0);
const par = new BigNumber(10000);
const negPar = par.times(-1);
const minLiquidatorRatio = new BigNumber('0.25');
const prices = [
  new BigNumber('1e20'),
  new BigNumber('1e18'),
  new BigNumber('1e18'),
  new BigNumber('1e21'),
];
const defaultIsClosing = false;
const defaultIsRecyclable = false;

describe('LiquidatorProxyV1', () => {
  before(async () => {
    const r = await getDolomiteMargin();
    dolomiteMargin = r.dolomiteMargin;
    accounts = r.accounts;
    admin = accounts[0];
    owner1 = dolomiteMargin.getDefaultAccount();
    owner2 = accounts[3];
    operator = accounts[6];

    await resetEVM();
    await setGlobalOperator(
      dolomiteMargin,
      accounts,
      dolomiteMargin.contracts.liquidatorProxyV1._address,
    );
    await setupMarkets(dolomiteMargin, accounts);
    await Promise.all([
      dolomiteMargin.testing.priceOracle.setPrice(
        dolomiteMargin.testing.tokenA.address,
        prices[0],
      ),
      dolomiteMargin.testing.priceOracle.setPrice(
        dolomiteMargin.testing.tokenB.address,
        prices[1],
      ),
      dolomiteMargin.testing.priceOracle.setPrice(
        dolomiteMargin.testing.tokenC.address,
        prices[2],
      ),
      dolomiteMargin.testing.priceOracle.setPrice(dolomiteMargin.weth.address, prices[3]),
      dolomiteMargin.permissions.approveOperator(operator, { from: owner1 }),
      dolomiteMargin.permissions.approveOperator(
        dolomiteMargin.contracts.liquidatorProxyV1.options.address,
        { from: owner1 },
      ),
    ]);
    await dolomiteMargin.admin.addMarket(
      dolomiteMargin.weth.address,
      dolomiteMargin.testing.priceOracle.address,
      dolomiteMargin.testing.interestSetter.address,
      zero,
      zero,
      zero,
      defaultIsClosing,
      defaultIsRecyclable,
      { from: admin },
    );
    await mineAvgBlock();

    snapshotId = await snapshot();
  });

  beforeEach(async () => {
    await resetEVM(snapshotId);
  });

  describe('#liquidate', () => {
    describe('Success cases', () => {
      it('Succeeds for one owed, one held', async () => {
        await setUpBasicBalances();
        await liquidate();
        await expectBalances([zero, par.times('105')], [zero, par.times('5')]);
      });

      it('Succeeds for one owed, one held (held first)', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            par.times('100'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            par.times('1.1'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            negPar.times('100'),
          ),
        ]);
        await liquidate();
        await expectBalances(
          [par.times('1.05'), zero],
          [par.times('.05'), zero],
        );
      });

      it('Succeeds for one owed, one held (undercollateralized)', async () => {
        await setUpBasicBalances();
        await dolomiteMargin.testing.setAccountBalance(
          owner2,
          accountNumber2,
          market2,
          par.times('95'),
        );
        await liquidate();
        await expectBalances(
          [par.times('0.0952'), par.times('95')],
          [negPar.times('0.0952'), zero],
        );
      });

      it('Succeeds for one owed, many held', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('60'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market3,
            par.times('50'),
          ),
        ]);
        const txResult = await liquidate();
        await expectBalances(
          [zero, par.times('60'), par.times('44.9925')],
          [zero, zero, par.times('5.0075')],
        );
        console.log(
          `\tLiquidatorProxyV1 gas used (1 owed, 2 held): ${txResult.gasUsed}`,
        );
      });

      it('Succeeds for many owed, one held', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            par.times('100'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            negPar.times('50'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market3,
            par.times('165'),
          ),
        ]);
        const txResult = await liquidate();
        await expectBalances(
          [zero, par.times('50'), par.times('157.5')],
          [zero, zero, par.times('7.5')],
        );
        console.log(
          `\tLiquidatorProxyV1 gas used (2 owed, 1 held): ${txResult.gasUsed}`,
        );
      });

      it('Succeeds for many owed, many held', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            par.times('150'),
          ),
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market4, par),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            par.times('0.525'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            negPar.times('100'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market3,
            par.times('170'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market4,
            negPar.times('0.1'),
          ),
        ]);
        const txResult = await liquidate();
        await expectBalances(
          [
            par.times('0.525'),
            par.times('50'),
            par.times('157.5'),
            par.times('0.9'),
          ],
          [zero, zero, par.times('12.5'), zero],
        );
        console.log(
          `\tLiquidatorProxyV1 gas used (2 owed, 2 held): ${txResult.gasUsed}`,
        );
      });

      it('Succeeds for liquid account collateralized but in liquid status', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('150'),
          ),
          dolomiteMargin.testing.setAccountStatus(
            owner2,
            accountNumber2,
            AccountStatus.Liquidating,
          ),
        ]);
        await liquidate();
        await expectBalances([zero, par.times('105')], [zero, par.times('45')]);
      });

      it('Succeeds for liquid account under collateralized because of margin premium', async () => {
        const marginPremium = new BigNumber('0.1'); // // this raises the liquidation threshold to 126.5% (115% * 1.1)
        const spreadPremium = new BigNumber('0.4'); // this raises the spread to 107% 100% + (5% * 1.4)
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('125'),
          ),
          dolomiteMargin.admin.setMarginPremium(
            market1,
            marginPremium,
            { from: admin },
          ),
          dolomiteMargin.admin.setSpreadPremium(
            market1,
            spreadPremium,
            { from: admin },
          ),
        ]);
        await liquidate();
        await expectBalances([zero, par.times('107')], [zero, par.times('18')]);
      });

      it('Succeeds when held asset is whitelisted for this contract', async () => {
        await dolomiteMargin.liquidatorAssetRegistry.addLiquidatorToAssetWhitelist(
          market2,
          dolomiteMargin.liquidatorProxyV1.address,
          { from: admin },
        );
        await setUpBasicBalances();
        await liquidate();
        await expectBalances([zero, par.times('105')], [zero, par.times('5')]);
      });
    });

    describe('Success cases for various initial liquidator balances', () => {
      it('Succeeds for one owed, one held (liquidator balance is zero)', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market4, par),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances(
          [negPar, par.times('105')],
          [zero, par.times('5')],
        );
      });

      it('Succeeds for one owed, one held (liquidator balance is posHeld/negOwed)', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            par.times('500'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances(
          [negPar.times(2), par.times('605')],
          [zero, par.times('5')],
        );
      });

      it('Succeeds for one owed, one held (liquidator balance is negatives)', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            negPar.div(2),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            negPar.times('50'),
          ),
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market4, par),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances(
          [negPar.times('1.5'), par.times('55')],
          [zero, par.times('5')],
        );
      });

      it('Succeeds for one owed, one held (liquidator balance is positives)', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            par.div(2),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            par.times('50'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances(
          [negPar.div(2), par.times('155')],
          [zero, par.times('5')],
        );
      });

      it('Succeeds for one owed, one held (liquidator balance is !posHeld>!negOwed)', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            par.div(2),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            negPar.times('100'),
          ),
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market4, par),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        const txResult = await liquidate();
        await expectBalances(
          [negPar.div(2), par.times('5')],
          [zero, par.times('5')],
        );
        console.log(`\tLiquidatorProxyV1 gas used: ${txResult.gasUsed}`);
      });

      it('Succeeds for one owed, one held (liquidator balance is !posHeld<!negOwed)', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            negPar.times('50'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances([zero, par.times('55')], [zero, par.times('5')]);
      });
    });

    describe('Limited by minLiquidatorRatio', () => {
      it('Liquidates as much as it can (to 1.25) but no more', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            negPar.div(2),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            par.times('65'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances(
          [negPar.times('0.625'), par.times('78.125')],
          [negPar.times('0.875'), par.times('96.875')],
        );
        const liquidatorValues = await dolomiteMargin.getters.getAccountValues(
          owner1,
          accountNumber1,
        );
        expect(liquidatorValues.supply).to.eql(
          liquidatorValues.borrow.times('1.25'),
        );
      });

      it('Liquidates to negOwed/posHeld and then to 1.25', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            par.times('0.2'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            negPar.times('10'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances(
          [negPar.times('0.55'), par.times('68.75')],
          [negPar.times('0.25'), par.times('31.25')],
        );
        const liquidatorValues = await dolomiteMargin.getters.getAccountValues(
          owner1,
          accountNumber1,
        );
        expect(liquidatorValues.supply).to.eql(
          liquidatorValues.borrow.times('1.25'),
        );
      });

      it('Liquidates to zero', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            negPar.times('105'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances([zero, zero], [zero, par.times('5')]);
      });

      it('Liquidates even if it starts below 1.25', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            par.times('2.4'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            negPar.times('200'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances(
          [par.times('1.4'), negPar.times('95')],
          [zero, par.times('5')],
        );
      });

      it('Does not liquidate below 1.25', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            negPar.div(2),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            par.times('60'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances(
          [negPar.div(2), par.times('60')],
          [negPar, par.times('110')],
        );
      });

      it('Does not liquidate at 1.25', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            par.times('125'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await liquidate();
        await expectBalances(
          [negPar, par.times('125')],
          [negPar, par.times('110')],
        );
      });
    });

    describe('Follows minValueLiquidated', () => {
      it('Succeeds for less than valueLiquidatable', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await dolomiteMargin.liquidatorProxyV1.liquidate(
          owner1,
          accountNumber1,
          owner2,
          accountNumber2,
          minLiquidatorRatio,
          par.times(prices[0]),
          [market1],
          [market2],
          { from: operator },
        );
        await expectBalances([zero, par.times('105')], [zero, par.times('5')]);
      });

      it('Succeeds for less than valueLiquidatable (even if liquidAccount is small)', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await dolomiteMargin.liquidatorProxyV1.liquidate(
          owner1,
          accountNumber1,
          owner2,
          accountNumber2,
          minLiquidatorRatio,
          par.times(prices[0]).times(5),
          [market1],
          [market2],
          { from: operator },
        );
        await expectBalances([zero, par.times('105')], [zero, par.times('5')]);
      });

      it('Reverts if cannot liquidate enough', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            par.times('0.2'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await expectThrow(
          dolomiteMargin.liquidatorProxyV1.liquidate(
            owner1,
            accountNumber1,
            owner2,
            accountNumber2,
            minLiquidatorRatio,
            par.times(prices[0]).times(2),
            [market1],
            [market2],
            { from: operator },
          ),
          'LiquidatorProxyV1: Not enough liquidatable value',
        );
      });

      it('Reverts if cannot liquidate even 1', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            negPar.times('125'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await expectThrow(
          dolomiteMargin.liquidatorProxyV1.liquidate(
            owner1,
            accountNumber1,
            owner2,
            accountNumber2,
            minLiquidatorRatio,
            new BigNumber(1),
            [market1],
            [market2],
            { from: operator },
          ),
          'LiquidatorProxyV1: Not enough liquidatable value',
        );
      });
    });

    describe('Follows preferences', () => {
      it('Liquidates the most specified markets first', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market4,
            par.times('0.02'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market3,
            negPar.times('100'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market4,
            par.times('0.11'),
          ),
        ]);
        await dolomiteMargin.liquidatorProxyV1.liquidate(
          owner1,
          accountNumber1,
          owner2,
          accountNumber2,
          minLiquidatorRatio,
          zero,
          [market3, market1],
          [market4, market2],
          { from: operator },
        );
        await expectBalances(
          [zero, zero, negPar.times('100'), par.times('0.125')],
          [negPar, par.times('110'), zero, par.times('.005')],
        );
      });

      it('Does not liquidate unspecified markets', async () => {
        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            par.times('100'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);
        await dolomiteMargin.liquidatorProxyV1.liquidate(
          owner1,
          accountNumber1,
          owner2,
          accountNumber2,
          minLiquidatorRatio,
          zero,
          [market2],
          [market1],
          { from: operator },
        );
        await expectBalances(
          [par, par.times('100')],
          [negPar, par.times('110')],
        );
      });
    });

    describe('Failure cases', () => {
      it('Fails for msg.sender is non-operator', async () => {
        await Promise.all([
          setUpBasicBalances(),
          dolomiteMargin.permissions.disapproveOperator(operator, { from: owner1 }),
        ]);
        await expectThrow(
          liquidate(),
          'LiquidatorProxyV1: Sender not operator',
        );
      });

      it('Fails for proxy is non-operator', async () => {
        await Promise.all([
          setUpBasicBalances(),
          dolomiteMargin.admin.setGlobalOperator(
            dolomiteMargin.contracts.liquidatorProxyV1.options.address,
            false,
            { from: accounts[0] },
          ),
        ]);
        await expectThrow(
          liquidate(),
          'Storage: Unpermissioned global operator',
        );
      });

      it('Fails for liquid account no supply', async () => {
        await setUpBasicBalances();
        await dolomiteMargin.testing.setAccountBalance(
          owner2,
          accountNumber2,
          market2,
          zero,
        );
        await expectThrow(
          liquidate(),
          'LiquidatorProxyV1: Liquid account no supply',
        );
      });

      it('Fails for liquid account not liquidatable', async () => {
        await setUpBasicBalances();
        await dolomiteMargin.testing.setAccountBalance(
          owner2,
          accountNumber2,
          market2,
          par.times('115'),
        );
        await expectThrow(
          liquidate(),
          'LiquidatorProxyV1: Liquid account not liquidatable',
        );
      });

      it('Fails for liquid account not liquidatable (with margin premium)', async () => {
        await setUpBasicBalances();
        const marginPremium = new BigNumber(0.1); // this raises the liquidation threshold to 126.5% (115% * 1.1)
        await dolomiteMargin.admin.setMarginPremium(market1, marginPremium, { from: admin });
        await dolomiteMargin.testing.setAccountBalance(
          owner2,
          accountNumber2,
          market2,
          par.times('130'),
        );
        await expectThrow(
          liquidate(),
          'LiquidatorProxyV1: Liquid account not liquidatable',
        );
      });

      it('Fails if asset is blacklisted by registry for this proxy contract', async () => {
        // Market2 (if held) cannot be liquidated by any contract
        await dolomiteMargin.liquidatorAssetRegistry.addLiquidatorToAssetWhitelist(
          market2,
          ADDRESSES.ONE,
          { from: admin },
        );
        await setUpBasicBalances();
        await expectThrow(
          liquidate(),
          `HasLiquidatorRegistry: Asset not whitelisted <${market2.toFixed()}>`,
        );
      });
    });

    describe('Interest cases', () => {
      it('Liquidates properly even if the indexes have changed', async () => {
        const rate = new BigNumber(1).div(INTEGERS.ONE_YEAR_IN_SECONDS);
        await Promise.all([
          dolomiteMargin.testing.interestSetter.setInterestRate(
            dolomiteMargin.testing.tokenA.address,
            rate,
          ),
          dolomiteMargin.testing.interestSetter.setInterestRate(
            dolomiteMargin.testing.tokenB.address,
            rate,
          ),
          dolomiteMargin.testing.setMarketIndex(market1, {
            borrow: new BigNumber('1.2'),
            supply: new BigNumber('1.1'),
            lastUpdate: zero,
          }),
          dolomiteMargin.testing.setMarketIndex(market2, {
            borrow: new BigNumber('1.2'),
            supply: new BigNumber('1.1'),
            lastUpdate: zero,
          }),
        ]);
        await fastForward(3600);

        await Promise.all([
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market1,
            par.div('2'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner1,
            accountNumber1,
            market2,
            negPar.times('30'),
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market1,
            negPar,
          ),
          dolomiteMargin.testing.setAccountBalance(
            owner2,
            accountNumber2,
            market2,
            par.times('110'),
          ),
        ]);

        await liquidate();
      });
    });
  });
});

// ============ Helper Functions ============

async function setUpBasicBalances() {
  await Promise.all([
    dolomiteMargin.testing.setAccountBalance(owner1, accountNumber1, market1, par),
    dolomiteMargin.testing.setAccountBalance(owner2, accountNumber2, market1, negPar),
    dolomiteMargin.testing.setAccountBalance(
      owner2,
      accountNumber2,
      market2,
      par.times('110'),
    ),
  ]);
}

async function liquidate() {
  const preferences = [market1, market2, market3, market4];
  return await dolomiteMargin.liquidatorProxyV1.liquidate(
    owner1,
    accountNumber1,
    owner2,
    accountNumber2,
    minLiquidatorRatio,
    zero,
    preferences,
    preferences,
    { from: operator },
  );
}

async function expectBalances(
  liquidatorBalances: (number | BigNumber)[],
  liquidBalances: (number | BigNumber)[],
) {
  const bal1 = await Promise.all([
    dolomiteMargin.getters.getAccountPar(owner1, accountNumber1, market1),
    dolomiteMargin.getters.getAccountPar(owner1, accountNumber1, market2),
    dolomiteMargin.getters.getAccountPar(owner1, accountNumber1, market3),
    dolomiteMargin.getters.getAccountPar(owner1, accountNumber1, market4),
  ]);
  const bal2 = await Promise.all([
    dolomiteMargin.getters.getAccountPar(owner2, accountNumber2, market1),
    dolomiteMargin.getters.getAccountPar(owner2, accountNumber2, market2),
    dolomiteMargin.getters.getAccountPar(owner2, accountNumber2, market3),
    dolomiteMargin.getters.getAccountPar(owner2, accountNumber2, market4),
  ]);

  for (let i = 0; i < liquidatorBalances.length; i += 1) {
    expect(bal1[i]).to.eql(liquidatorBalances[i]);
  }
  for (let i = 0; i < liquidBalances.length; i += 1) {
    expect(bal2[i]).to.eql(liquidBalances[i]);
  }
}
