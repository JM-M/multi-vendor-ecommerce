import { TRPCError } from "@trpc/server";
import type Stripe from "stripe";
import { z } from "zod";

import { PLATFORM_FEE_PERCENTAGE } from "@/constants";
import { stripe } from "@/lib/stripe";
import { generateTenantURL } from "@/lib/utils";
import { Media, Tenant } from "@/payload-types";
import {
  baseProcedure,
  createTRPCRouter,
  protectedProcedure,
} from "@/trpc/init";
import { CheckoutMetadata, ProductMetadata } from "../types";

export const checkoutRouter = createTRPCRouter({
  verify: protectedProcedure.mutation(async ({ ctx }) => {
    const user = await ctx.db.findByID({
      collection: "users",
      id: ctx.session.user.id,
      depth: 0,
    });

    if (!user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "User not found",
      });
    }

    const tenantId = user?.tenants?.[0]?.tenant as string; // This is an ID because of depth: 0
    const tenant = await ctx.db.findByID({
      collection: "tenants",
      id: tenantId,
    });

    if (!tenant) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Tenant not found",
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: tenant.stripeAccountId,
      refresh_url: `${process.env.NEXT_PUBLIC_APP_URL}/admin`,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/admin`,
      type: "account_onboarding",
    });

    if (!accountLink.url) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create account link",
      });
    }

    return { url: accountLink.url };
  }),
  purchase: protectedProcedure
    .input(
      z.object({
        productIds: z.array(z.string()).min(1),
        tenantSlug: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { productIds, tenantSlug } = input;
      const products = await ctx.db.find({
        collection: "products",
        depth: 2, // Populate "category", "image", "tenant", & "tenant.image"
        where: {
          and: [
            {
              id: {
                in: productIds,
              },
            },
            {
              "tenant.slug": {
                equals: tenantSlug,
              },
            },
            {
              isArchived: {
                not_equals: true,
              },
            },
          ],
        },
      });

      if (products.totalDocs !== productIds.length) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "One or more products not found for the specified tenant",
        });
      }

      const tenantsData = await ctx.db.find({
        collection: "tenants",
        depth: 1, // Populate "image"
        limit: 1,
        pagination: false,
        where: {
          slug: {
            equals: tenantSlug,
          },
        },
      });

      const tenant = tenantsData.docs.at(0);

      if (!tenant) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Tenant not found",
        });
      }

      if (!tenant.stripeDetailsSubmitted) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Tenant not allowed to sell products",
        });
      }

      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] =
        products.docs.map((product) => ({
          quantity: 1, // Assuming quantity is always 1 since these are digital products
          price_data: {
            currency: "usd", // Assuming USD for simplicity
            unit_amount: Math.round(Number(product.price) * 100), // Convert to cents
            product_data: {
              name: product.name,
              metadata: {
                stripeAccountId: tenant.stripeAccountId || "",
                id: product.id,
                name: product.name,
                price: product.price,
              } as ProductMetadata,
            },
          },
        }));

      const totalAmount = products.docs.reduce(
        (acc, product) => acc + product.price * 100,
        0,
      );

      const platformFeeAmount = Math.round(
        totalAmount * (PLATFORM_FEE_PERCENTAGE / 100),
      );

      console.log(
        generateTenantURL(input.tenantSlug, "/checkout?success=true"),
      );
      const checkout = await stripe.checkout.sessions.create(
        {
          customer_email: ctx.session.user.email,
          success_url: generateTenantURL(
            input.tenantSlug,
            "/checkout?success=true",
          ),
          cancel_url: generateTenantURL(
            input.tenantSlug,
            "/checkout?cancel=true",
          ),
          mode: "payment",
          line_items: lineItems,
          invoice_creation: {
            enabled: true,
          },
          metadata: {
            userId: ctx.session.user.id,
          } as CheckoutMetadata,
          payment_intent_data: {
            application_fee_amount: platformFeeAmount,
          },
        },
        {
          stripeAccount: tenant.stripeAccountId,
        },
      );

      if (!checkout.url) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create checkout session",
        });
      }

      return {
        url: checkout.url,
      };
    }),
  getProducts: baseProcedure
    .input(
      z.object({
        ids: z.array(z.string()),
      }),
    )
    .query(async ({ ctx, input }) => {
      const data = await ctx.db.find({
        collection: "products",
        depth: 2, // Populate "category", "image", "tenant", & "tenant.image"
        where: {
          and: [
            {
              id: {
                in: input.ids,
              },
            },
            {
              isArchived: {
                not_equals: true,
              },
            },
          ],
        },
      });

      if (data.totalDocs !== input.ids.length) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "One or more products not found",
        });
      }

      const totalPrice = data.docs.reduce((acc, product) => {
        const price = Number(product.price);
        return acc + (isNaN(price) ? 0 : price);
      }, 0);

      return {
        ...data,
        totalPrice,
        docs: data.docs.map((doc) => ({
          ...doc,
          image: doc.image as Media | null,
          tenant: doc.tenant as Tenant & { image: Media | null },
        })),
      };
    }),
});
