/*

    Copyright 2023 Dolomite.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

*/

pragma solidity ^0.5.7;
pragma experimental ABIEncoderV2;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IDolomiteMargin } from "../../protocol/interfaces/IDolomiteMargin.sol";
import { IERC20Detailed } from "../../protocol/interfaces/IERC20Detailed.sol";

import { Account } from "../../protocol/lib/Account.sol";
import { Actions } from "../../protocol/lib/Actions.sol";
import { Events } from "../../protocol/lib/Events.sol";
import { ExcessivelySafeCall } from "../../protocol/lib/ExcessivelySafeCall.sol";
import { Require } from "../../protocol/lib/Require.sol";

import { OnlyDolomiteMargin } from "../helpers/OnlyDolomiteMargin.sol";

import { IExpiry } from "../interfaces/IExpiry.sol";
import { IGenericTraderProxyBase } from "../interfaces/IGenericTraderProxyBase.sol";
import { IIsolationModeToken } from "../interfaces/IIsolationModeToken.sol";
import { IIsolationModeUnwrapperTrader } from "../interfaces/IIsolationModeUnwrapperTrader.sol";
import { IIsolationModeUnwrapperTraderV2 } from "../interfaces/IIsolationModeUnwrapperTraderV2.sol";
import { IIsolationModeWrapperTrader } from "../interfaces/IIsolationModeWrapperTrader.sol";
import { IIsolationModeWrapperTraderV2 } from "../interfaces/IIsolationModeWrapperTraderV2.sol";

import { AccountActionLib } from "../lib/AccountActionLib.sol";


/**
 * @title   GenericTraderProxyBase
 * @author  Dolomite
 *
 * @dev Base contract with validation and utilities for trading any asset from an account
 */
contract GenericTraderProxyBase is IGenericTraderProxyBase {

    // ============ Constants ============

    bytes32 private constant FILE = "GenericTraderProxyBase";

    /// @dev The index of the trade account in the accounts array (for executing an operation)
    uint256 internal constant TRADE_ACCOUNT_ID = 0;
    uint256 internal constant ZAP_ACCOUNT_ID = 1;

    bytes32 internal constant GLP_ISOLATION_MODE_HASH = keccak256(bytes("Dolomite: Fee + Staked GLP"));
    bytes32 internal constant ISOLATION_MODE_PREFIX_HASH = keccak256(bytes("Dolomite Isolation:"));
    uint256 internal constant DOLOMITE_ISOLATION_LENGTH = 19;

    // ============ Public Functions ============

    function isIsolationModeMarket(
        IDolomiteMargin _dolomiteMargin,
        uint256 _marketId
    ) public view returns (bool) {
        (bool isSuccess, bytes memory returnData) = ExcessivelySafeCall.safeStaticCall(
            _dolomiteMargin.getMarketTokenAddress(_marketId),
            IERC20Detailed(address(0)).name.selector,
            bytes("")
        );
        if (!isSuccess) {
            return false;
        }
        string memory name = abi.decode(returnData, (string));
        return (
            (bytes(name).length >= DOLOMITE_ISOLATION_LENGTH
                && _hashSubstring(
                    name,
                    /* _startIndex = */ 0, // solium-disable-line indentation
                    /* _endIndex = */ DOLOMITE_ISOLATION_LENGTH // solium-disable-line indentation
                ) == ISOLATION_MODE_PREFIX_HASH
            )
            || keccak256(bytes(name)) == GLP_ISOLATION_MODE_HASH
        );
    }

    // ============ Internal Functions ============

    function _validateMarketIdPath(
        uint256[] memory _marketIdsPath
    ) internal pure {
        if (_marketIdsPath.length >= 2) { /* FOR COVERAGE TESTING */ }
        Require.that(_marketIdsPath.length >= 2,
            FILE,
            "Invalid market path length"
        );
    }

    function _validateAmountWeis(
        uint256 _inputAmountWei,
        uint256 _minOutputAmountWei
    )
        internal
        pure
    {
        if (_inputAmountWei > 0) { /* FOR COVERAGE TESTING */ }
        Require.that(_inputAmountWei > 0,
            FILE,
            "Invalid inputAmountWei"
        );
        if (_minOutputAmountWei > 0) { /* FOR COVERAGE TESTING */ }
        Require.that(_minOutputAmountWei > 0,
            FILE,
            "Invalid minOutputAmountWei"
        );
    }

    function _validateTraderParams(
        GenericTraderProxyCache memory _cache,
        uint256[] memory _marketIdsPath,
        Account.Info[] memory _makerAccounts,
        TraderParam[] memory _traderParamsPath
    )
        internal
        view
    {
        if (_marketIdsPath.length == _traderParamsPath.length + 1) { /* FOR COVERAGE TESTING */ }
        Require.that(_marketIdsPath.length == _traderParamsPath.length + 1,
            FILE,
            "Invalid traders params length"
        );

        for (uint256 i = 0; i < _traderParamsPath.length; i++) {
            _validateTraderParam(
                _cache,
                _marketIdsPath,
                _makerAccounts,
                _traderParamsPath[i],
                /* _index = */ i // solium-disable-line indentation
            );
        }
    }

    function _validateTraderParam(
        GenericTraderProxyCache memory _cache,
        uint256[] memory _marketIdsPath,
        Account.Info[] memory _makerAccounts,
        TraderParam memory _traderParam,
        uint256 _index
    )
        internal
        view
    {
        if (_traderParam.trader != address(0)) { /* FOR COVERAGE TESTING */ }
        Require.that(_traderParam.trader != address(0),
            FILE,
            "Invalid trader at index",
            _index
        );

        uint256 marketId = _marketIdsPath[_index];
        uint256 nextMarketId = _marketIdsPath[_index + 1];
        _validateIsolationModeStatusForTraderParam(
            _cache,
            marketId,
            nextMarketId,
            _traderParam
        );
        _validateTraderTypeForTraderParam(
            _cache,
            marketId,
            nextMarketId,
            _traderParam,
            _index
        );
        _validateMakerAccountForTraderParam(
            _makerAccounts,
            _traderParam,
            _index
        );
    }

    function _validateIsolationModeStatusForTraderParam(
        GenericTraderProxyCache memory _cache,
        uint256 _marketId,
        uint256 _nextMarketId,
        TraderParam memory _traderParam
    ) internal view {
        if (isIsolationModeMarket(_cache.dolomiteMargin, _marketId)) {
            // If the current market is in isolation mode, the trader type must be for isolation mode assets
            if (_isUnwrapperTraderType(_traderParam.traderType)) { /* FOR COVERAGE TESTING */ }
            Require.that(_isUnwrapperTraderType(_traderParam.traderType),
                FILE,
                "Invalid isolation mode unwrapper",
                _marketId,
                uint256(uint8(_traderParam.traderType))
            );

            if (isIsolationModeMarket(_cache.dolomiteMargin, _nextMarketId)) {
                // If the user is unwrapping into an isolation mode asset, the next market must trust this trader
                address isolationModeToken = _cache.dolomiteMargin.getMarketTokenAddress(_nextMarketId);
                if (IIsolationModeToken(isolationModeToken).isTokenConverterTrusted(_traderParam.trader)) { /* FOR COVERAGE TESTING */ }
                Require.that(IIsolationModeToken(isolationModeToken).isTokenConverterTrusted(_traderParam.trader),
                    FILE,
                    "Invalid unwrap sequence",
                    _marketId,
                    _nextMarketId
                );
            }
        } else if (isIsolationModeMarket(_cache.dolomiteMargin, _nextMarketId)) {
            // If the next market is in isolation mode, the trader must wrap the current asset into the isolation asset.
            if (_isWrapperTraderType(_traderParam.traderType)) { /* FOR COVERAGE TESTING */ }
            Require.that(_isWrapperTraderType(_traderParam.traderType),
                FILE,
                "Invalid isolation mode wrapper",
                _nextMarketId,
                uint256(uint8(_traderParam.traderType))
            );
        } else {
            // If neither asset is in isolation mode, the trader type must be for non-isolation mode assets
            if (_traderParam.traderType == TraderType.ExternalLiquidity|| _traderParam.traderType == TraderType.InternalLiquidity) { /* FOR COVERAGE TESTING */ }
            Require.that(_traderParam.traderType == TraderType.ExternalLiquidity
                    || _traderParam.traderType == TraderType.InternalLiquidity,
                FILE,
                "Invalid trader type",
                uint256(uint8(_traderParam.traderType))
            );
        }
    }

    function _validateTraderTypeForTraderParam(
        GenericTraderProxyCache memory _cache,
        uint256 _marketId,
        uint256 _nextMarketId,
        TraderParam memory _traderParam,
        uint256 _index
    ) internal view {
        if (_isUnwrapperTraderType(_traderParam.traderType)) {
            IIsolationModeUnwrapperTrader unwrapperTrader = IIsolationModeUnwrapperTrader(_traderParam.trader);
            address isolationModeToken = _cache.dolomiteMargin.getMarketTokenAddress(_marketId);
            if (unwrapperTrader.token() == isolationModeToken) { /* FOR COVERAGE TESTING */ }
            Require.that(unwrapperTrader.token() == isolationModeToken,
                FILE,
                "Invalid input for unwrapper",
                _index,
                _marketId
            );
            if (unwrapperTrader.isValidOutputToken(_cache.dolomiteMargin.getMarketTokenAddress(_nextMarketId))) { /* FOR COVERAGE TESTING */ }
            Require.that(unwrapperTrader.isValidOutputToken(_cache.dolomiteMargin.getMarketTokenAddress(_nextMarketId)),
                FILE,
                "Invalid output for unwrapper",
                _index + 1,
                _nextMarketId
            );
            if (IIsolationModeToken(isolationModeToken).isTokenConverterTrusted(_traderParam.trader)) { /* FOR COVERAGE TESTING */ }
            Require.that(IIsolationModeToken(isolationModeToken).isTokenConverterTrusted(_traderParam.trader),
                FILE,
                "Unwrapper trader not enabled",
                _traderParam.trader,
                _marketId
            );
        } else if (_isWrapperTraderType(_traderParam.traderType)) {
            IIsolationModeWrapperTrader wrapperTrader = IIsolationModeWrapperTrader(_traderParam.trader);
            address isolationModeToken = _cache.dolomiteMargin.getMarketTokenAddress(_nextMarketId);
            if (wrapperTrader.isValidInputToken(_cache.dolomiteMargin.getMarketTokenAddress(_marketId))) { /* FOR COVERAGE TESTING */ }
            Require.that(wrapperTrader.isValidInputToken(_cache.dolomiteMargin.getMarketTokenAddress(_marketId)),
                FILE,
                "Invalid input for wrapper",
                _index,
                _marketId
            );
            if (wrapperTrader.token() == isolationModeToken) { /* FOR COVERAGE TESTING */ }
            Require.that(wrapperTrader.token() == isolationModeToken,
                FILE,
                "Invalid output for wrapper",
                _index + 1,
                _nextMarketId
            );
            if (IIsolationModeToken(isolationModeToken).isTokenConverterTrusted(_traderParam.trader)) { /* FOR COVERAGE TESTING */ }
            Require.that(IIsolationModeToken(isolationModeToken).isTokenConverterTrusted(_traderParam.trader),
                FILE,
                "Wrapper trader not enabled",
                _traderParam.trader,
                _nextMarketId
            );
        }
    }

    function _validateMakerAccountForTraderParam(
        Account.Info[] memory _makerAccounts,
        TraderParam memory _traderParam,
        uint256 _index
    ) internal pure {
        if (TraderType.InternalLiquidity == _traderParam.traderType) {
            // The makerAccountOwner should be set if the traderType is InternalLiquidity
            if (_traderParam.makerAccountIndex < _makerAccounts.length&& _makerAccounts[_traderParam.makerAccountIndex].owner != address(0)) { /* FOR COVERAGE TESTING */ }
            Require.that(_traderParam.makerAccountIndex < _makerAccounts.length
                && _makerAccounts[_traderParam.makerAccountIndex].owner != address(0),
                FILE,
                "Invalid maker account owner",
                _index
            );
        } else {
            // The makerAccountOwner and makerAccountNumber is not used if the traderType is not InternalLiquidity
            if (_traderParam.makerAccountIndex == 0) { /* FOR COVERAGE TESTING */ }
            Require.that(_traderParam.makerAccountIndex == 0,
                FILE,
                "Invalid maker account owner",
                _index
            );
        }
    }

    function _validateZapAccount(
        GenericTraderProxyCache memory _cache,
        Account.Info memory _account,
        uint256[] memory _marketIdsPath
    ) internal view {
        for (uint256 i = 0; i < _marketIdsPath.length; i++) {
            // Panic if we're zapping to an account that has any value in it. Why? Because we don't want execute trades
            // where we sell ALL if there's already value in the account. That would mess up the user's holdings and
            // unintentionally sell assets the user does not want to sell.
          /*assert(_cache.dolomiteMargin.getAccountPar(_account, _marketIdsPath[i]).value == 0);*/
        }
    }

    function _getAccounts(
        GenericTraderProxyCache memory _cache,
        Account.Info[] memory _makerAccounts,
        address _tradeAccountOwner,
        uint256 _tradeAccountNumber
    )
        internal
        view
        returns (Account.Info[] memory)
    {
        Account.Info[] memory accounts = new Account.Info[](_cache.traderAccountStartIndex + _makerAccounts.length);
        accounts[TRADE_ACCOUNT_ID] = Account.Info({
            owner: _tradeAccountOwner,
            number: _tradeAccountNumber
        });
        accounts[ZAP_ACCOUNT_ID] = Account.Info({
            owner: _tradeAccountOwner,
            number: _calculateZapAccountNumber(_tradeAccountOwner, _tradeAccountNumber)
        });
        _appendTradersToAccounts(_cache, _makerAccounts, accounts);
        return accounts;
    }

    function _appendTradersToAccounts(
        GenericTraderProxyCache memory _cache,
        Account.Info[] memory _makerAccounts,
        Account.Info[] memory _accounts
    )
        internal
        pure
    {
        for (uint256 i = 0; i < _makerAccounts.length; i++) {
            Account.Info memory account = _accounts[_cache.traderAccountStartIndex + i];
          /*assert(account.owner == address(0) && account.number == 0);*/

            _accounts[_cache.traderAccountStartIndex + i] = Account.Info({
                owner: _makerAccounts[i].owner,
                number: _makerAccounts[i].number
            });
        }
    }

    function _getActionsLengthForTraderParams(
        TraderParam[] memory _tradersPath
    )
        internal
        pure
        returns (uint256)
    {
        uint256 actionsLength = 2; // start at 2 for the zap in/out of the zap account (2 transfer actions)
        for (uint256 i = 0; i < _tradersPath.length; i++) {
            if (_isUnwrapperTraderType(_tradersPath[i].traderType)) {
                actionsLength += IIsolationModeUnwrapperTrader(_tradersPath[i].trader).actionsLength();
            } else if (_isWrapperTraderType(_tradersPath[i].traderType)) {
                actionsLength += IIsolationModeWrapperTrader(_tradersPath[i].trader).actionsLength();
            } else {
                actionsLength += 1;
            }
        }
        return actionsLength;
    }

    function _appendTraderActions(
        Account.Info[] memory _accounts,
        Actions.ActionArgs[] memory _actions,
        GenericTraderProxyCache memory _cache,
        uint256[] memory _marketIdsPath,
        uint256 _inputAmountWei,
        uint256 _minOutputAmountWei,
        TraderParam[] memory _tradersPath
    )
        internal
        view
    {
        // Before the trades are started, transfer inputAmountWei of the inputMarket from the TRADE account to the ZAP account
        if (_inputAmountWei == uint256(-1)) {
            // Transfer such that we TARGET w/e the trader has right now, before the trades occur
            _actions[_cache.actionsCursor++] = AccountActionLib.encodeTransferToTargetAmountAction(
                TRADE_ACCOUNT_ID,
                ZAP_ACCOUNT_ID,
                _marketIdsPath[0],
                /* _targetAmountWei = */ _cache.dolomiteMargin.getAccountWei(
                    _accounts[TRADE_ACCOUNT_ID],
                    _marketIdsPath[0]
                )
            );
        } else {
            _actions[_cache.actionsCursor++] = AccountActionLib.encodeTransferAction(
                TRADE_ACCOUNT_ID,
                ZAP_ACCOUNT_ID,
                _marketIdsPath[0],
                _inputAmountWei
            );
        }

        for (uint256 i = 0; i < _tradersPath.length; i++) {
            if (_tradersPath[i].traderType == TraderType.ExternalLiquidity) {
                _actions[_cache.actionsCursor++] = AccountActionLib.encodeExternalSellAction(
                    ZAP_ACCOUNT_ID,
                    _marketIdsPath[i],
                    _marketIdsPath[i + 1],
                    _tradersPath[i].trader,
                    _getInputAmountWeiForIndex(_inputAmountWei, i),
                    _getMinOutputAmountWeiForIndex(_minOutputAmountWei, i, _tradersPath.length),
                    _tradersPath[i].tradeData
                );
            } else if (_tradersPath[i].traderType == TraderType.InternalLiquidity) {
                (
                    uint256 customInputAmountWei,
                    bytes memory tradeData
                ) = abi.decode(_tradersPath[i].tradeData, (uint256, bytes));
                if ((i == 0 && customInputAmountWei == _inputAmountWei) || i != 0) { /* FOR COVERAGE TESTING */ }
                Require.that((i == 0 && customInputAmountWei == _inputAmountWei) || i != 0,
                    FILE,
                    "Invalid custom input amount"
                );
                _actions[_cache.actionsCursor++] = AccountActionLib.encodeInternalTradeActionWithCustomData(
                    ZAP_ACCOUNT_ID,
                    /* _makerAccountId = */ _tradersPath[i].makerAccountIndex + _cache.traderAccountStartIndex,
                    _marketIdsPath[i],
                    _marketIdsPath[i + 1],
                    _tradersPath[i].trader,
                    customInputAmountWei,
                    tradeData
                );
            } else if (_isUnwrapperTraderType(_tradersPath[i].traderType)) {
                // We can't use a Require for the following assert, because there's already an invariant that enforces
                // the trader is an `IsolationModeWrapper` if the market ID at `i + 1` is in isolation mode. Meaning,
                // an unwrapper can never appear at the non-zero index because there is an invariant that checks the
                // `IsolationModeWrapper` is the last index
              /*assert(i == 0);*/
                Actions.ActionArgs[] memory unwrapperActions = IIsolationModeUnwrapperTraderV2(_tradersPath[i].trader)
                    .createActionsForUnwrapping(
                        IIsolationModeUnwrapperTraderV2.CreateActionsForUnwrappingParams({
                            primaryAccountId: ZAP_ACCOUNT_ID,
                            otherAccountId: _otherAccountId(),
                            primaryAccountOwner: _accounts[ZAP_ACCOUNT_ID].owner,
                            primaryAccountNumber: _accounts[ZAP_ACCOUNT_ID].number,
                            otherAccountOwner: _accounts[_otherAccountId()].owner,
                            otherAccountNumber: _accounts[_otherAccountId()].number,
                            outputMarket: _marketIdsPath[i + 1],
                            inputMarket: _marketIdsPath[i],
                            minOutputAmount: _getMinOutputAmountWeiForIndex(_minOutputAmountWei, i, _tradersPath.length),
                            inputAmount: _getInputAmountWeiForIndex(_inputAmountWei, i),
                            orderData: _tradersPath[i].tradeData
                        })
                    );

                for (uint256 j = 0; j < unwrapperActions.length; j++) {
                    _actions[_cache.actionsCursor++] = unwrapperActions[j];
                }
            } else {
                // Panic if the developer messed up the `else` statement here
              /*assert(_isWrapperTraderType(_tradersPath[i].traderType));*/
                if (i == _tradersPath.length - 1) { /* FOR COVERAGE TESTING */ }
                Require.that(i == _tradersPath.length - 1,
                    FILE,
                    "Wrapper must be the last trader"
                );

                Actions.ActionArgs[] memory wrapperActions = IIsolationModeWrapperTraderV2(_tradersPath[i].trader)
                    .createActionsForWrapping(
                        IIsolationModeWrapperTraderV2.CreateActionsForWrappingParams({
                        primaryAccountId: ZAP_ACCOUNT_ID,
                        otherAccountId: _otherAccountId(),
                        primaryAccountOwner: _accounts[ZAP_ACCOUNT_ID].owner,
                        primaryAccountNumber: _accounts[ZAP_ACCOUNT_ID].number,
                        otherAccountOwner: _accounts[_otherAccountId()].owner,
                        otherAccountNumber: _accounts[_otherAccountId()].number,
                        outputMarket: _marketIdsPath[i + 1],
                        inputMarket: _marketIdsPath[i],
                        minOutputAmount: _getMinOutputAmountWeiForIndex(_minOutputAmountWei, i, _tradersPath.length),
                        inputAmount: _getInputAmountWeiForIndex(_inputAmountWei, i),
                        orderData: _tradersPath[i].tradeData
                        })
                    );

                for (uint256 j = 0; j < wrapperActions.length; j++) {
                    _actions[_cache.actionsCursor++] = wrapperActions[j];
                }
            }
        }

        // When the trades are finished, transfer all of the outputMarket from the ZAP account to the TRADE account
        _actions[_cache.actionsCursor++] = AccountActionLib.encodeTransferAction(
            ZAP_ACCOUNT_ID,
            TRADE_ACCOUNT_ID,
            _marketIdsPath[_marketIdsPath.length - 1],
            AccountActionLib.all()
        );
    }

    /**
     * @return  The index of the account that is not the Zap account. For the liquidation contract, this is
     *          the account being liquidated. For the GenericTrader contract this is the same as the trader account.
     */
    function _otherAccountId() internal pure returns (uint256);

    function _isWrapperTraderType(
        TraderType _traderType
    )
        internal
        pure
        returns (bool)
    {
        return TraderType.IsolationModeWrapper == _traderType;
    }

    function _isUnwrapperTraderType(
        TraderType _traderType
    )
        internal
        pure
        returns (bool)
    {
        return TraderType.IsolationModeUnwrapper == _traderType;
    }

    // ==================== Private Functions ====================

    function _calculateZapAccountNumber(
        address _tradeAccountOwner,
        uint256 _tradeAccountNumber
    )
        private
        view
        returns (uint256)
    {
        return uint256(keccak256(abi.encodePacked(_tradeAccountOwner, _tradeAccountNumber, block.timestamp)));
    }

    function _getInputAmountWeiForIndex(
        uint256 _inputAmountWei,
        uint256 _index
    )
        private
        pure
        returns (uint256)
    {
        return _index == 0 ? _inputAmountWei : AccountActionLib.all();
    }

    function _getMinOutputAmountWeiForIndex(
        uint256 _minOutputAmountWei,
        uint256 _index,
        uint256 _tradersPathLength
    )
        private
        pure
        returns (uint256)
    {
        return _index == _tradersPathLength - 1 ? _minOutputAmountWei : 1;
    }

    function _hashSubstring(
        string memory _value,
        uint256 _startIndex,
        uint256 _endIndex
    )
        private
        pure
        returns (bytes32)
    {
        bytes memory strBytes = bytes(_value);
        bytes memory result = new bytes(_endIndex - _startIndex);
        for (uint256 i = _startIndex; i < _endIndex; i++) {
            result[i - _startIndex] = strBytes[i];
        }
        return keccak256(result);
    }
}
