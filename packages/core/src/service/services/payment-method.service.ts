import { Injectable } from '@nestjs/common';
import { PaymentMethodQuote } from '@vendure/common/lib/generated-shop-types';
import {
    ConfigurableOperationDefinition,
    CreatePaymentMethodInput,
    DeletionResponse,
    DeletionResult,
    UpdatePaymentMethodInput,
} from '@vendure/common/lib/generated-types';
import { omit } from '@vendure/common/lib/omit';
import { DEFAULT_CHANNEL_CODE } from '@vendure/common/lib/shared-constants';
import { ID, PaginatedList } from '@vendure/common/lib/shared-types';

import { RequestContext } from '../../api/common/request-context';
import { RelationPaths } from '../../api/index';
import { UserInputError } from '../../common/error/errors';
import { ListQueryOptions } from '../../common/types/common-types';
import { idsAreEqual } from '../../common/utils';
import { ConfigService } from '../../config/config.service';
import { PaymentMethodEligibilityChecker } from '../../config/payment/payment-method-eligibility-checker';
import { PaymentMethodHandler } from '../../config/payment/payment-method-handler';
import { TransactionalConnection } from '../../connection/transactional-connection';
import { Order } from '../../entity/order/order.entity';
import { PaymentMethod } from '../../entity/payment-method/payment-method.entity';
import { EventBus } from '../../event-bus/event-bus';
import { PaymentMethodEvent } from '../../event-bus/events/payment-method-event';
import { ConfigArgService } from '../helpers/config-arg/config-arg.service';
import { ListQueryBuilder } from '../helpers/list-query-builder/list-query-builder';
import { patchEntity } from '../helpers/utils/patch-entity';

import { ChannelService } from './channel.service';

/**
 * @description
 * Contains methods relating to {@link PaymentMethod} entities.
 *
 * @docsCategory services
 */
@Injectable()
export class PaymentMethodService {
    constructor(
        private connection: TransactionalConnection,
        private configService: ConfigService,
        private listQueryBuilder: ListQueryBuilder,
        private eventBus: EventBus,
        private configArgService: ConfigArgService,
        private channelService: ChannelService,
    ) {}

    findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<PaymentMethod>,
        relations: RelationPaths<PaymentMethod> = [],
    ): Promise<PaginatedList<PaymentMethod>> {
        return this.listQueryBuilder
            .build(PaymentMethod, options, { ctx, relations, channelId: ctx.channelId })
            .getManyAndCount()
            .then(([items, totalItems]) => ({
                items,
                totalItems,
            }));
    }

    findOne(
        ctx: RequestContext,
        paymentMethodId: ID,
        relations: RelationPaths<PaymentMethod> = [],
    ): Promise<PaymentMethod | undefined> {
        return this.connection.findOneInChannel(ctx, PaymentMethod, paymentMethodId, ctx.channelId, {
            relations,
        });
    }

    async create(ctx: RequestContext, input: CreatePaymentMethodInput): Promise<PaymentMethod> {
        const paymentMethod = new PaymentMethod(input);
        paymentMethod.handler = this.configArgService.parseInput('PaymentMethodHandler', input.handler);
        if (input.checker) {
            paymentMethod.checker = this.configArgService.parseInput(
                'PaymentMethodEligibilityChecker',
                input.checker,
            );
        }
        await this.channelService.assignToCurrentChannel(paymentMethod, ctx);
        const savedPaymentMethod = await this.connection
            .getRepository(ctx, PaymentMethod)
            .save(paymentMethod);
        this.eventBus.publish(new PaymentMethodEvent(ctx, savedPaymentMethod, 'created', input));
        return savedPaymentMethod;
    }

    async update(ctx: RequestContext, input: UpdatePaymentMethodInput): Promise<PaymentMethod> {
        const paymentMethod = await this.connection.getEntityOrThrow(ctx, PaymentMethod, input.id);
        const updatedPaymentMethod = patchEntity(paymentMethod, omit(input, ['handler', 'checker']));
        if (input.checker) {
            paymentMethod.checker = this.configArgService.parseInput(
                'PaymentMethodEligibilityChecker',
                input.checker,
            );
        }
        if (input.checker === null) {
            paymentMethod.checker = null;
        }
        if (input.handler) {
            paymentMethod.handler = this.configArgService.parseInput('PaymentMethodHandler', input.handler);
        }
        this.eventBus.publish(new PaymentMethodEvent(ctx, paymentMethod, 'updated', input));
        return this.connection.getRepository(ctx, PaymentMethod).save(updatedPaymentMethod);
    }

    async delete(
        ctx: RequestContext,
        paymentMethodId: ID,
        force: boolean = false,
    ): Promise<DeletionResponse> {
        const paymentMethod = await this.connection.getEntityOrThrow(ctx, PaymentMethod, paymentMethodId, {
            relations: ['channels'],
            channelId: ctx.channelId,
        });
        if (ctx.channel.code === DEFAULT_CHANNEL_CODE) {
            const nonDefaultChannels = paymentMethod.channels.filter(
                channel => channel.code !== DEFAULT_CHANNEL_CODE,
            );
            if (0 < nonDefaultChannels.length && !force) {
                const message = ctx.translate('message.payment-method-used-in-channels', {
                    channelCodes: nonDefaultChannels.map(c => c.code).join(', '),
                });
                const result = DeletionResult.NOT_DELETED;
                return { result, message };
            }
            try {
                await this.connection.getRepository(ctx, PaymentMethod).remove(paymentMethod);
                this.eventBus.publish(new PaymentMethodEvent(ctx, paymentMethod, 'deleted', paymentMethodId));
                return {
                    result: DeletionResult.DELETED,
                };
            } catch (e) {
                return {
                    result: DeletionResult.NOT_DELETED,
                    message: e.message || String(e),
                };
            }
        } else {
            // If not deleting from the default channel, we will not actually delete,
            // but will remove from the current channel
            paymentMethod.channels = paymentMethod.channels.filter(c => !idsAreEqual(c.id, ctx.channelId));
            await this.connection.getRepository(ctx, PaymentMethod).save(paymentMethod);
            this.eventBus.publish(new PaymentMethodEvent(ctx, paymentMethod, 'deleted', paymentMethodId));
            return {
                result: DeletionResult.DELETED,
            };
        }
    }

    getPaymentMethodEligibilityCheckers(ctx: RequestContext): ConfigurableOperationDefinition[] {
        return this.configArgService
            .getDefinitions('PaymentMethodEligibilityChecker')
            .map(x => x.toGraphQlType(ctx));
    }

    getPaymentMethodHandlers(ctx: RequestContext): ConfigurableOperationDefinition[] {
        return this.configArgService.getDefinitions('PaymentMethodHandler').map(x => x.toGraphQlType(ctx));
    }

    async getEligiblePaymentMethods(ctx: RequestContext, order: Order): Promise<PaymentMethodQuote[]> {
        const paymentMethods = await this.connection
            .getRepository(ctx, PaymentMethod)
            .find({ where: { enabled: true }, relations: ['channels'] });
        const results: PaymentMethodQuote[] = [];
        const paymentMethodsInChannel = paymentMethods.filter(p =>
            p.channels.find(pc => idsAreEqual(pc.id, ctx.channelId)),
        );
        for (const method of paymentMethodsInChannel) {
            let isEligible = true;
            let eligibilityMessage: string | undefined;
            if (method.checker) {
                const checker = this.configArgService.getByCode(
                    'PaymentMethodEligibilityChecker',
                    method.checker.code,
                );
                const eligible = await checker.check(ctx, order, method.checker.args, method);
                if (eligible === false || typeof eligible === 'string') {
                    isEligible = false;
                    eligibilityMessage = typeof eligible === 'string' ? eligible : undefined;
                }
            }
            results.push({
                id: method.id,
                code: method.code,
                name: method.name,
                description: method.description,
                isEligible,
                eligibilityMessage,
                customFields: method.customFields,
            });
        }
        return results;
    }

    async getMethodAndOperations(
        ctx: RequestContext,
        method: string,
    ): Promise<{
        paymentMethod: PaymentMethod;
        handler: PaymentMethodHandler;
        checker: PaymentMethodEligibilityChecker | null;
    }> {
        const paymentMethod = await this.connection
            .getRepository(ctx, PaymentMethod)
            .createQueryBuilder('method')
            .leftJoin('method.channels', 'channel')
            .where('method.code = :code', { code: method })
            .andWhere('channel.id = :channelId', { channelId: ctx.channelId })
            .getOne();
        if (!paymentMethod) {
            throw new UserInputError(`error.payment-method-not-found`, { method });
        }
        const handler = this.configArgService.getByCode('PaymentMethodHandler', paymentMethod.handler.code);
        const checker =
            paymentMethod.checker &&
            this.configArgService.getByCode('PaymentMethodEligibilityChecker', paymentMethod.checker.code);
        return { paymentMethod, handler, checker };
    }
}
