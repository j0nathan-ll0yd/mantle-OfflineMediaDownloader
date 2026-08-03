import {createQueryFactory} from '@j0nathan-ll0yd/database'
import {getDrizzleClient} from '#db/client'

export const {defineQuery, definePreparedQuery} = createQueryFactory(getDrizzleClient)
